const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));

function generateId() {
  return crypto.randomBytes(6).toString("hex");
}

function generateRoomCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function getUsername(value) {
  const username = String(value || "").trim();

  return username.length > 0 && username.length <= 30 ? username : null;
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(room, message, except) {
  for (const participant of room.participants.values()) {
    if (participant !== except) {
      send(participant, message);
    }
  }
}

function leaveRoom(socket) {
  const roomCode = socket.roomCode;
  const room = rooms.get(roomCode);

  if (!room) {
    socket.roomCode = null;
    return;
  }

  room.participants.delete(socket.id);

  if (room.hostId === socket.id) {
    for (const participant of room.participants.values()) {
      send(participant, {
        type: "room-closed",
        message: "O criador encerrou a reunião."
      });
    }
    rooms.delete(roomCode);
  } else {
    broadcast(room, {
      type: "participant-left",
      participantId: socket.id
    });

    if (room.participants.size === 0) {
      rooms.delete(roomCode);
    }
  }

  socket.roomCode = null;
}

wss.on("connection", (socket) => {
  socket.id = generateId();
  socket.roomCode = null;

  send(socket, { type: "ready", participantId: socket.id });

  socket.on("message", (rawMessage) => {
    let message;

    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      send(socket, { type: "error", message: "Mensagem inválida." });
      return;
    }

    if (message.type === "create-room") {
      const username = getUsername(message.username);

      if (!username) {
        send(socket, {
          type: "error",
          message: "Informe um nome de usuário com até 30 caracteres."
        });
        return;
      }

      const roomCode = generateRoomCode();
      const room = { hostId: socket.id, participants: new Map() };

      socket.username = username;
      room.participants.set(socket.id, socket);
      rooms.set(roomCode, room);
      socket.roomCode = roomCode;

      send(socket, { type: "room-created", roomCode });
      send(socket, {
        type: "room-state",
        participants: []
      });
      return;
    }

    if (message.type === "join-room") {
      const username = getUsername(message.username);
      const roomCode = String(message.roomCode || "").toUpperCase();
      const room = rooms.get(roomCode);

      if (!username) {
        send(socket, {
          type: "error",
          message: "Informe um nome de usuário com até 30 caracteres."
        });
        return;
      }

      if (!room) {
        send(socket, { type: "error", message: "Sala não encontrada." });
        return;
      }

      const participants = [...room.participants.values()].map(
        (participant) => ({
          participantId: participant.id,
          username: participant.username
        })
      );
      socket.username = username;
      room.participants.set(socket.id, socket);
      socket.roomCode = roomCode;

      send(socket, { type: "joined-room", roomCode });
      send(socket, { type: "room-state", participants });
      broadcast(
        room,
        {
          type: "participant-joined",
          participantId: socket.id,
          username
        },
        socket
      );
      return;
    }

    if (message.type === "signal") {
      const room = rooms.get(socket.roomCode);
      const target = room?.participants.get(message.target);

      if (target) {
        send(target, {
          type: "signal",
          from: socket.id,
          data: message.data
        });
      }
    }

    if (message.type === "leave-room") {
      leaveRoom(socket);
    }
  });

  socket.on("close", () => {
    leaveRoom(socket);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Servidor executando em http://localhost:${PORT}`);
});
