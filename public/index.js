// WebRTC and WebSocket client for screen sharing and audio conferencing
const socketProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const socket = new WebSocket(`${socketProtocol}://${window.location.host}`);

// DOM elements for the lobby and meeting views
const lobbyView = document.getElementById("lobbyView");
const meetingView = document.getElementById("meetingView");
const createRoomButton = document.getElementById("createRoomButton");
const joinRoomButton = document.getElementById("joinRoomButton");
const shareScreenButton = document.getElementById("shareScreenButton");
const muteButton = document.getElementById("muteButton");
const leaveRoomButton = document.getElementById("leaveRoomButton");
const usernameInput = document.getElementById("usernameInput");
const roomInput = document.getElementById("roomInput");
const roomCodeElement = document.getElementById("roomCode");
const remoteVideos = document.getElementById("remoteVideos");
const noScreenMessage = document.getElementById("noScreenMessage");
const participantsList = document.getElementById("participantsList");
const lobbyStatusElement = document.getElementById("lobbyStatus");
const statusElement = document.getElementById("status");

// RTC configuration and state management
const rtcConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

// Peer connection and media state management
const peerConnections = new Map();
const pendingCandidates = new Map();
const remoteMedia = new Map();
const peerNames = new Map();
const pendingNegotiations = new Set();
const peerVolumes = new Map();

function applyVolume(peerId) {
  const media = remoteMedia.get(peerId);
  const volume = peerVolumes.get(peerId) ?? 1;

  if (media?.audio) media.audio.volume = volume;
  if (media?.video) media.video.volume = volume;
}

// Local media and room state management
let localStream = null;
let localAudioTrack = null;
let audioContext = null;
let rawMicStream = null;
let noiseLevel = 0;
let currentRoomCode = null;
let participantId = null;
let activeScreenStream = null;

function setStatus(message) {
  lobbyStatusElement.textContent = message;
  statusElement.textContent = message;
}

function setView(view) {
  const isMeeting = view === "meeting";
  lobbyView.hidden = isMeeting;
  meetingView.hidden = !isMeeting;
}

function sendMessage(message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function updateSharedScreenView() {
  const hasSharedScreen = [...remoteMedia.values()].some(
    (media) => media.card
  );

  remoteVideos.hidden = !hasSharedScreen;
  noScreenMessage.hidden = hasSharedScreen;
}

function setShareButtonState(isSharing) {
  shareScreenButton.textContent = isSharing
    ? "Parar compartilhamento"
    : "Compartilhar tela e áudio do PC";
  shareScreenButton.classList.toggle("button-primary", !isSharing);
  shareScreenButton.classList.toggle("button-danger", isSharing);
}

function renderParticipants() {
  participantsList.replaceChildren();

  for (const [id, username] of peerNames) {
    const item = document.createElement("li");

    item.textContent = id === participantId ? `${username} (você)` : username;

    if (id !== participantId) {
      const slider = document.createElement("input");

      slider.type = "range";
      slider.min = "0";
      slider.max = "1";
      slider.step = "0.05";
      slider.value = peerVolumes.get(id) ?? 1;
      slider.className = "volume-slider";
      slider.title = `Volume de ${username}`;
      slider.setAttribute("aria-label", `Volume de ${username}`);
      slider.addEventListener("input", () => {
        peerVolumes.set(id, Number(slider.value));
        applyVolume(id);
      });
      item.appendChild(slider);
    }

    participantsList.appendChild(item);
  }
}

function getUsername() {
  const username = usernameInput.value.trim();

  if (!username) {
    setStatus("Digite seu nome antes de entrar.");
    usernameInput.focus();
    return null;
  }

  return username;
}

async function prepareMicrophone() {
  if (localStream) {
    return;
  }

  const rawStream = await navigator.mediaDevices.getUserMedia({
    audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true }
  });

  audioContext = new AudioContext();
  rawMicStream = rawStream;

  const source = audioContext.createMediaStreamSource(rawStream);
  const destination = audioContext.createMediaStreamDestination();
  const processor = audioContext.createScriptProcessor(1024, 1, 1);
  let gain = 1;

  // Noise gate: quiet audio below the slider-defined threshold is faded out.
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);
    let sum = 0;

    for (let i = 0; i < input.length; i++) {
      sum += input[i] * input[i];
    }

    const rms = Math.sqrt(sum / input.length);
    const threshold = noiseLevel * 0.04;
    const target = noiseLevel === 0 || rms > threshold ? 1 : 0;
    const rate = target > gain ? 0.2 : 0.02;

    for (let i = 0; i < input.length; i++) {
      gain += (target - gain) * rate;
      output[i] = input[i] * gain;
    }
  };

  source.connect(processor);
  processor.connect(destination);

  localStream = destination.stream;
  localAudioTrack = localStream.getAudioTracks()[0];
}

function hideRemoteVideo(peerId) {
  const media = remoteMedia.get(peerId);

  if (!media?.card) {
    return;
  }

  media.card.remove();
  media.card = null;
  media.video = null;
  updateSharedScreenView();
}

function showRemoteVideo(peerId, stream) {
  const media = remoteMedia.get(peerId);

  if (!media || media.card) {
    return;
  }

  const card = document.createElement("article");
  const name = document.createElement("h3");
  const video = document.createElement("video");

  card.className = "participant-card";
  name.textContent = peerNames.get(peerId) || "Participante";
  video.autoplay = true;
  video.playsInline = true;
  video.controls = true;
  video.srcObject = stream;
  card.append(name, video);
  remoteVideos.appendChild(card);

  media.card = card;
  media.video = video;
  applyVolume(peerId);
  updateSharedScreenView();
}

function createPeerConnection(peerId) {
  if (peerConnections.has(peerId)) {
    return peerConnections.get(peerId);
  }

  const connection = new RTCPeerConnection(rtcConfiguration);
  peerConnections.set(peerId, connection);
  pendingCandidates.set(peerId, []);

  for (const track of localStream.getTracks()) {
    const sourceStream = activeScreenStream?.getTracks().includes(track)
      ? activeScreenStream
      : localStream;

    connection.addTrack(track, sourceStream);
  }

  connection.onicecandidate = (event) => {
    if (event.candidate) {
      sendMessage({
        type: "signal",
        target: peerId,
        data: {
          type: "ice-candidate",
          candidate: event.candidate
        }
      });
    }
  };

  connection.ontrack = (event) => {
    const stream = event.streams[0];
    let media = remoteMedia.get(peerId);

    if (!media) {
      const audio = document.createElement("audio");

      audio.autoplay = true;
      audio.hidden = true;
      audio.srcObject = stream;
      document.body.appendChild(audio);
      media = { audio, card: null, video: null };
      remoteMedia.set(peerId, media);
      applyVolume(peerId);
    }

    if (event.track.kind !== "video") {
      return;
    }

    const showVideo = () => showRemoteVideo(peerId, stream);
    const hideVideo = () => hideRemoteVideo(peerId);

    event.track.addEventListener("unmute", showVideo);
    event.track.addEventListener("mute", hideVideo);
    event.track.addEventListener("ended", hideVideo);

    if (!event.track.muted) {
      showVideo();
    }
  };

  connection.onconnectionstatechange = () => {
    if (
      connection.connectionState === "failed" ||
      connection.connectionState === "disconnected"
    ) {
      removePeer(peerId);
    }
  };

  connection.onsignalingstatechange = () => {
    if (
      connection.signalingState === "stable" &&
      pendingNegotiations.delete(peerId)
    ) {
      negotiate(peerId).catch((error) => {
        setStatus("Não foi possível atualizar o compartilhamento.");
        console.error(error);
      });
    }
  };

  return connection;
}

async function negotiate(peerId) {
  const connection = peerConnections.get(peerId);

  if (!connection) {
    return;
  }

  if (connection.signalingState !== "stable") {
    pendingNegotiations.add(peerId);
    return;
  }

  pendingNegotiations.delete(peerId);

  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);

  sendMessage({
    type: "signal",
    target: peerId,
    data: {
      type: "offer",
      offer
    }
  });
}

async function connectToPeer(peerId) {
  createPeerConnection(peerId);
  await negotiate(peerId);
}

async function addPendingCandidates(peerId, connection) {
  const candidates = pendingCandidates.get(peerId) || [];

  for (const candidate of candidates) {
    await connection.addIceCandidate(candidate);
  }

  pendingCandidates.set(peerId, []);
}

async function handleOffer(peerId, offer) {
  const connection = createPeerConnection(peerId);

  await connection.setRemoteDescription(offer);
  await addPendingCandidates(peerId, connection);

  const answer = await connection.createAnswer();
  await connection.setLocalDescription(answer);

  sendMessage({
    type: "signal",
    target: peerId,
    data: {
      type: "answer",
      answer
    }
  });
}

async function handleSignal(peerId, data) {
  if (data.type === "offer") {
    await handleOffer(peerId, data.offer);
    return;
  }

  const connection = peerConnections.get(peerId);

  if (data.type === "answer" && connection) {
    await connection.setRemoteDescription(data.answer);
    await addPendingCandidates(peerId, connection);

    sendMessage({
      type: "signal",
      target: peerId,
      data: { type: "screen-sync-request" }
    });
    return;
  }

  if (data.type === "screen-sync-request") {
    if (activeScreenStream) {
      await negotiate(peerId);
    }
    return;
  }

  if (data.type === "ice-candidate") {
    if (connection?.remoteDescription) {
      await connection.addIceCandidate(data.candidate);
    } else {
      const candidates = pendingCandidates.get(peerId) || [];
      candidates.push(data.candidate);
      pendingCandidates.set(peerId, candidates);
    }
  }
}

async function shareScreen() {
  if (activeScreenStream) {
    return;
  }

  const screenStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true
  });

  activeScreenStream = screenStream;
  setShareButtonState(true);

  for (const track of screenStream.getTracks()) {
    localStream.addTrack(track);

    for (const [peerId, connection] of peerConnections) {
      connection.addTrack(track, screenStream);
    }

    track.addEventListener("ended", () => {
      endScreenShare().catch((error) => {
        setStatus("Não foi possível encerrar o compartilhamento.");
        console.error(error);
      });
    });
  }

  for (const peerId of peerConnections.keys()) {
    await negotiate(peerId);
  }

  setStatus("Tela e áudio do computador compartilhados.");
}

async function endScreenShare() {
  const screenStream = activeScreenStream;

  if (!screenStream) {
    return;
  }

  activeScreenStream = null;
  setShareButtonState(false);

  for (const track of screenStream.getTracks()) {
    for (const connection of peerConnections.values()) {
      const sender = connection.getSenders().find(
        (item) => item.track === track
      );

      if (sender) {
        connection.removeTrack(sender);
      }
    }

    localStream.removeTrack(track);
  }

  for (const peerId of peerConnections.keys()) {
    await negotiate(peerId);
  }

  setStatus("O compartilhamento foi encerrado.");
}

async function stopSharingScreen() {
  const screenStream = activeScreenStream;

  if (!screenStream) {
    return;
  }

  await endScreenShare();

  for (const track of screenStream.getTracks()) {
    track.stop();
  }
}

function removePeer(peerId) {
  const connection = peerConnections.get(peerId);

  if (connection) {
    connection.close();
    peerConnections.delete(peerId);
  }

  pendingCandidates.delete(peerId);
  pendingNegotiations.delete(peerId);

  const media = remoteMedia.get(peerId);
  if (media) {
    media.audio.srcObject = null;
    media.audio.remove();
    hideRemoteVideo(peerId);
    remoteMedia.delete(peerId);
  }

  peerNames.delete(peerId);
  renderParticipants();
  updateSharedScreenView();
}

function resetMeeting() {
  for (const peerId of peerConnections.keys()) {
    removePeer(peerId);
  }

  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.stop();
    }
  }

  rawMicStream?.getTracks().forEach((track) => track.stop());
  audioContext?.close();
  rawMicStream = null;
  audioContext = null;
  localStream = null;
  localAudioTrack = null;
  activeScreenStream = null;
  currentRoomCode = null;
  roomCodeElement.textContent = "-";
  roomInput.value = "";
  remoteVideos.replaceChildren();
  peerNames.clear();
  peerVolumes.clear();
  renderParticipants();
  updateSharedScreenView();
  muteButton.textContent = "Mutar microfone";
  setShareButtonState(false);
  setView("lobby");
}

function leaveRoom() {
  if (!currentRoomCode) {
    return;
  }

  sendMessage({ type: "leave-room" });
  resetMeeting();
  setStatus("Você saiu da reunião.");
}

async function enterRoom(messageType, roomCode, username) {
  try {
    await prepareMicrophone();
  } catch (error) {
    setStatus("Não foi possível acessar o microfone.");
    console.error(error);
    return;
  }

  sendMessage({ type: messageType, roomCode, username });
  setStatus("Entrando na reunião...");
}

//#region Event Listeners for UI Buttons
createRoomButton.addEventListener("click", async () => {
  const username = getUsername();

  if (!username) {
    return;
  }

  try {
    await prepareMicrophone();
    peerNames.set(participantId, username);
    renderParticipants();
    sendMessage({ type: "create-room", username });
    setStatus("Criando reunião...");
  } catch (error) {
    setStatus("Não foi possível acessar o microfone.");
    console.error(error);
  }
});

leaveRoomButton.addEventListener("click", leaveRoom);

joinRoomButton.addEventListener("click", async () => {
  const roomCode = roomInput.value.trim().toUpperCase();
  const username = getUsername();

  if (!roomCode) {
    setStatus("Digite o código da sala.");
    return;
  }

  if (!username) {
    return;
  }

  peerNames.set(participantId, username);
  renderParticipants();
  await enterRoom("join-room", roomCode, username);
});

const noiseSlider = document.getElementById("noiseSlider");
noiseSlider.addEventListener("input", () => {
  noiseLevel = Number(noiseSlider.value);
});

muteButton.addEventListener("click", () => {
  if (!localAudioTrack) {
    return;
  }

  localAudioTrack.enabled = !localAudioTrack.enabled;
  muteButton.textContent = localAudioTrack.enabled
    ? "Mutar microfone"
    : "Ativar microfone";
});

shareScreenButton.addEventListener("click", async () => {
  if (activeScreenStream) {
    try {
      await stopSharingScreen();
    } catch (error) {
      setStatus("Não foi possível encerrar o compartilhamento.");
      console.error(error);
    }
    return;
  }

  try {
    await shareScreen();
  } catch (error) {
    setStatus("O compartilhamento foi cancelado ou falhou.");
    console.error(error);
  }
});
//#endregion

//#region WebSocket Event Listeners
socket.addEventListener("message", async (event) => {
  const message = JSON.parse(event.data);

  if (message.type === "ready") {
    participantId = message.participantId;
    return;
  }

  if (message.type === "room-created" || message.type === "joined-room") {
    currentRoomCode = message.roomCode;
    roomCodeElement.textContent = currentRoomCode;
    setView("meeting");
    setStatus("Você está na reunião.");
    return;
  }

  if (message.type === "room-state") {
    for (const participant of message.participants) {
      peerNames.set(participant.participantId, participant.username);
      await connectToPeer(participant.participantId);
    }
    renderParticipants();
    return;
  }

  if (message.type === "participant-joined") {
    peerNames.set(message.participantId, message.username);
    renderParticipants();
    setStatus(`${message.username} entrou na reunião.`);
    return;
  }

  if (message.type === "signal") {
    await handleSignal(message.from, message.data);
    return;
  }

  if (message.type === "participant-left") {
    removePeer(message.participantId);
    setStatus("Um participante saiu da reunião.");
    return;
  }

  if (message.type === "room-closed") {
    resetMeeting();
    setStatus(message.message);
    alert(message.message || "O criador saiu e a reunião foi encerrada.");
    return;
  }

  if (message.type === "error") {
    setStatus(message.message);
  }
});

socket.addEventListener("open", () => {
  setStatus("Conectado ao servidor.");
});

socket.addEventListener("close", () => {
  setStatus("Conexão com o servidor encerrada.");
});
//#endregion