// server.js
const express = require("express");
const app = express();
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const pako = require("pako");
require("dotenv").config();
// If you don't use GoogleGenerativeAI in production, you can remove related code
const { GoogleGenerativeAI } = require("@google/generative-ai");
const connectDB = require('./lib/dbConnect');
const { default: Classes } = require("./models/Classes");

const server = http.createServer(app);
connectDB();

app.use(
  cors({
    origin: [
      "*",
      "https://sih-2025-white-board.vercel.app",
      "http://localhost:3001",
      "https://localhost:3000",
    ],
  })
);
app.use(express.json());

/**
 * In-memory store:
 * rooms = {
 *   [roomID]: {
 *     slides: [
 *       { id: slideId, title: "Slide 1", elements: [ ... ] },
 *       ...
 *     ],
 *     currentSlide: 0,
 *     users: [{ userID, socketId, role? }]
 *   }
 * }
 *
 * Note: This is memory-only. For persistence, move to DB.
 */
let rooms = {};

// setInterval(() => {
//   console.log("\n\nCurrent rooms state:", JSON.stringify(rooms));
// }, 5000);

// Utilities
const compress = (data) => {
  const json = JSON.stringify(data);
  return pako.deflate(json);
};

const isMediaFile = (fileType) => {
  const mediaTypes = ["image/", "video/", "audio/", "application/pdf"];
  return mediaTypes.some((type) => fileType.toLowerCase().startsWith(type));
};

const isUrlOrTextFile = (fileType, fileName) => {
  const textTypes = [
    "text/",
    "application/json",
    "application/xml",
    "application/javascript",
  ];
  const textExtensions = [
    ".txt",
    ".json",
    ".xml",
    ".js",
    ".css",
    ".html",
    ".url",
  ];
  return (
    textTypes.some((type) => fileType.toLowerCase().startsWith(type)) ||
    textExtensions.some((ext) => fileName.toLowerCase().endsWith(ext))
  );
};

const io = new Server(server, {
  cors: {
    origin: [
      "*",
      "https://sih-2025-white-board.vercel.app",
      "http://localhost:3000",
      "https://localhost:3000",
      "http://localhost:3001",

    ],
    methods: ["GET", "POST"],
  },
});

// Helper: ensure a room exists and has at least one slide
const ensureRoom = (roomID) => {
  if (!rooms[roomID]) {
    const defaultSlide = {
      id: "slide-1",
      title: "Slide 1",
      elements: [],
    };
    rooms[roomID] = {
      slides: [defaultSlide],
      currentSlide: 0,
      users: [],
    };
  }
};

// Helper: get slide object by slideId or by index
const getSlideByIdOrIndex = (
  roomID,
  { slideId = null, slideIndex = null } = {}
) => {
  ensureRoom(roomID);
  const room = rooms[roomID];
  if (slideId) {
    return room.slides.find((s) => s.id === slideId) || null;
  }
  if (typeof slideIndex === "number") {
    return room.slides[slideIndex] || null;
  }
  return room.slides[room.currentSlide] || null;
};

// Update/add element in specific slide
const updateElementInRoomSlide = (
  elementData,
  roomID,
  { slideId = null, slideIndex = null } = {}
) => {
  ensureRoom(roomID);
  const room = rooms[roomID];
  let slide = getSlideByIdOrIndex(roomID, { slideId, slideIndex });
  if (!slide) {
    // fallback to current slide
    slide = room.slides[room.currentSlide];
  }

  const index = slide.elements.findIndex((el) => el.id === elementData.id);
  if (index === -1) {
    // Preserve important image props
    const completeElement = {
      ...elementData,
      ...(elementData.type === "image" && {
        src: elementData.src,
        width: elementData.width || 200,
        height: elementData.height || 200,
      }),
    };
    slide.elements.push(completeElement);
    console.log(
      `Added new ${elementData.type} element to room ${roomID} slide ${slide.id}`
    );
  } else {
    slide.elements[index] = { ...slide.elements[index], ...elementData };
    console.log(
      `Updated ${elementData.type} element in room ${roomID} slide ${slide.id}`
    );
  }
};

// Remove element from slide
const removeElementFromSlide = (
  elementId,
  roomID,
  { slideId = null, slideIndex = null } = {}
) => {
  ensureRoom(roomID);
  const slide = getSlideByIdOrIndex(roomID, { slideId, slideIndex });
  if (!slide) return false;
  const before = slide.elements.length;
  slide.elements = slide.elements.filter((e) => e.id !== elementId);
  const after = slide.elements.length;
  return before !== after;
};

// Socket events
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);
  // console.log(socket)

  // Join a room (class)
  socket.on("join-room", ({ roomID, UserID }) => {
    if (!roomID || !UserID) {
      socket.emit("join-error", { message: "Missing roomID or UserID" });
      return;
    }

    socket.join(roomID);
    socket.userID = UserID;
    socket.roomID = roomID;

    ensureRoom(roomID);

    // add to room's user list (avoid duplicates)
    rooms[roomID].users = rooms[roomID].users.filter(
      (u) => u.socketId !== socket.id
    );
    rooms[roomID].users.push({ userID: UserID, socketId: socket.id });

    // Send full room state to joining user (slides + currentSlide)
    const roomState = {
      slides: rooms[roomID].slides,
      currentSlide: rooms[roomID].currentSlide,
      users: rooms[roomID].users.map((u) => u.userID),
    };
    socket.emit("whiteboard-state", roomState);

    // Notify others in room that a new user joined
    socket.broadcast
      .to(roomID)
      .emit("user-joined", { userID: UserID, socketId: socket.id });

    console.log(
      `User ${JSON.stringify(roomID)} joined room ${JSON.stringify(
        UserID
      )}. Slides: ${rooms[roomID].slides.length}`
    );
  });

  socket.on("whiteboard:saveAll", async ({ roomID }) => {
    try {
      const roomData = rooms[roomID]; // In-memory slides + elements
      if (!roomData) {
        return socket.emit("error", "Room data not found in memory");
      }

      // Map frontend slides to backend schema
      const slides = roomData.slides.map((slide) => ({
        id: slide.slideId, // frontend slideId -> backend id
        title: slide.title || "Untitled Slide",
        elements: slide.elements.map((el) => ({
          type: el.type,
          points: el.points || [],
          x1: el.x1,
          y1: el.y1,
          x2: el.x2,
          y2: el.y2,
          color: el.color,
          strokeWidth: el.strokeWidth,
          fill: el.fill,
          fillStyle: el.fillStyle, // must match frontend
          src: el.src,
          text: el.text,
          startTime: el.startTime,
        })),
      }));

      // Save or update class document
      const classDoc = await Classes.findOneAndUpdate(
        { roomID },
        {
          slides,
          title: roomData.title || "Untitled Class",
          teacher: roomData.teacher || "Unknown Teacher",
          date: roomData.date || new Date(),
        },
        { new: true, upsert: true }
      );

      socket.emit("whiteboard:saved", { success: true, classId: classDoc._id });
      console.log(`✅ Whiteboard saved for room ${roomID}`);
    } catch (err) {
      console.error("❌ Failed to save whiteboard:", err);
      socket.emit("whiteboard:saved", { success: false, error: err.message });
    }
  });

  // Create new slide
  socket.on("create-slide", ({ roomID, title }) => {
    ensureRoom(roomID);
    const room = rooms[roomID];
    const newSlideId = `slide-${Date.now()}`;
    const newSlide = {
      id: newSlideId,
      title: title || `Slide ${room.slides.length + 1}`,
      elements: [],
    };
    room.slides.push(newSlide);
    // Optionally switch to this slide immediately:
    room.currentSlide = room.slides.length - 1;
    io.to(roomID).emit("slide-created", {
      slide: newSlide,
      currentSlide: room.currentSlide,
    });
    console.log(`Created slide ${newSlideId} in room ${roomID}`);
  });

  // Delete slide (by id)
  socket.on("delete-slide", ({ roomID, slideId }) => {
    ensureRoom(roomID);
    const room = rooms[roomID];
    const before = room.slides.length;
    room.slides = room.slides.filter((s) => s.id !== slideId);
    if (room.currentSlide >= room.slides.length) {
      room.currentSlide = Math.max(0, room.slides.length - 1);
    }
    io.to(roomID).emit("slide-deleted", {
      slideId,
      currentSlide: room.currentSlide,
    });
    console.log(
      `Deleted slide ${slideId} from room ${roomID} (${before} -> ${room.slides.length})`
    );
  });

  // Rename slide
  socket.on("rename-slide", ({ roomID, slideId, newTitle }) => {
    const slide = getSlideByIdOrIndex(roomID, { slideId });
    if (!slide) {
      socket.emit("error", { message: "Slide not found" });
      return;
    }
    slide.title = newTitle;
    io.to(roomID).emit("slide-renamed", { slideId, newTitle });
  });

  // Switch slide (by index or id)
  socket.on("switch-slide", ({ roomID, slideIndex = null, slideId = null }) => {
    ensureRoom(roomID);
    const room = rooms[roomID];
    let newIndex = room.currentSlide;
    if (typeof slideIndex === "number") {
      if (slideIndex >= 0 && slideIndex < room.slides.length)
        newIndex = slideIndex;
    } else if (slideId) {
      const idx = room.slides.findIndex((s) => s.id === slideId);
      if (idx !== -1) newIndex = idx;
    }
    room.currentSlide = newIndex;
    io.to(roomID).emit("slide-switched", {
      currentSlide: newIndex,
      slide: room.slides[newIndex],
    });
    console.log(`Room ${roomID} switched to slide ${newIndex}`);
  });

  // Client updates a single element (must provide elementData and optionally slideId/slideIndex)
  socket.on(
    "element-update",
    ({ elementData, roomID, slideId = null, slideIndex = null }) => {
      if (!elementData || !roomID) return;
      console.log("Server received element:", elementData.type, elementData.id);
      if (elementData.type === "image") {
        console.log(
          "Image details:",
          elementData.src,
          elementData.width,
          elementData.height
        );
      }
      updateElementInRoomSlide(elementData, roomID, { slideId, slideIndex });
      // Broadcast update to others in room (include slideId so clients know which slide to update)
      socket.broadcast
        .to(roomID)
        .emit("element-updated", { elementData, slideId, slideIndex });
    }
  );

  // Update whole elements array for a slide
  socket.on(
    "elements-update",
    ({
      elements: updatedElements,
      roomID,
      slideId = null,
      slideIndex = null,
    }) => {
      ensureRoom(roomID);
      let slide = getSlideByIdOrIndex(roomID, { slideId, slideIndex });
      if (!slide) {
        slide = rooms[roomID].slides[rooms[roomID].currentSlide];
      }
      slide.elements = updatedElements || [];
      const compressed = compress(slide.elements);
      socket.broadcast
        .to(roomID)
        .emit("elements-updated", { compressed, slideId: slide.id });
      console.log(
        `Elements replaced for room ${roomID} slide ${slide.id}. Count: ${slide.elements.length}`
      );
    }
  );

  // Remove element from a slide
  socket.on(
    "element-removal",
    ({ elementId, roomID, slideId = null, slideIndex = null }) => {
      console.log(`Removing element ${elementId} from room ${roomID}`);
      ensureRoom(roomID);
      const removed = removeElementFromSlide(elementId, roomID, {
        slideId,
        slideIndex,
      });
      if (removed) {
        io.to(roomID).emit("element-removal", {
          elementId,
          slideId,
          slideIndex,
        });
        console.log(`Element ${elementId} removed from room ${roomID}`);
      } else {
        console.log(`Element ${elementId} not found in room ${roomID}`);
      }
    }
  );

  // Clear whiteboard for current slide or all slides
  socket.on(
    "whiteboard-clear",
    ({ roomID, scope = "current", slideId = null, slideIndex = null }) => {
      ensureRoom(roomID);
      if (scope === "all") {
        rooms[roomID].slides.forEach((s) => (s.elements = []));
        io.to(roomID).emit("whiteboard-clear", { scope: "all" });
        console.log(`Cleared all slides in room ${roomID}`);
      } else {
        const slide = getSlideByIdOrIndex(roomID, { slideId, slideIndex });
        if (slide) {
          slide.elements = [];
          io.to(roomID).emit("whiteboard-clear", {
            scope: "current",
            slideId: slide.id,
          });
          console.log(`Cleared slide ${slide.id} in room ${roomID}`);
        }
      }
    }
  );

  // Cursor position broadcast (attached to room)
  socket.on("cursor-position", ({ cursorData, roomID }) => {
    socket.broadcast
      .to(roomID)
      .emit("cursor-position", { ...cursorData, userId: socket.userID });
  });

  socket.on("remove-cursor-position", ({ roomID, userId }) => {
    if (!roomID || !userId) return;

    console.log(`Removing cursor for user ${userId} in room ${roomID}`);

    // Broadcast to all other clients in the room to remove this cursor
    socket.broadcast.to(roomID).emit("cursor-position-removed", { userId });
  });

  // Quiz example (broadcast to room)
  socket.on("quiz", ({ correctAnswer, question, options, roomID }) => {
    console.log(`Quiz in ${roomID}: question=${question}`);
    socket.broadcast
      .to(roomID)
      .emit("quiz", { correctAnswer, question, options, roomID });
  });

  // File transfer handlers
  socket.on("file", ({ roomID, fileName, fileType, fileData }) => {
    console.log(
      `File transfer - Name: ${fileName}, Type: ${fileType}, Room: ${roomID}`
    );
    if (isMediaFile(fileType)) {
      console.log("Media file detected - applying compression");
      const compressedFile = compress({ fileName, fileType, fileData });
      socket.broadcast.to(roomID).emit("file-media", compressedFile);
    } else if (isUrlOrTextFile(fileType, fileName)) {
      console.log("URL/Text file detected - sending without compression");
      socket.broadcast
        .to(roomID)
        .emit("file-url", { fileName, fileType, fileData });
    } else {
      console.log("Other file type detected - applying compression as default");
      const compressedFile = compress({ fileName, fileType, fileData });
      socket.broadcast.to(roomID).emit("file-other", compressedFile);
    }
    // Fallback generic event (fixed spelling)
    socket.broadcast
      .to(roomID)
      .emit("file-received", { fileName, fileType, fileData });
    console.log(
      `Broadcasting file to ${
        rooms[roomID]?.users?.length || 0
      } users in room ${roomID}`
    );
  });

  // Website sharing
  socket.on("share-website", ({ websiteUrl, roomID, userID }) => {
    console.log(
      `User ${userID} is sharing website: ${websiteUrl} in room: ${roomID}`
    );
    try {
      new URL(websiteUrl);
      socket.to(roomID).emit("website-shared", { websiteUrl, userID });
    } catch (error) {
      console.error("Invalid URL format on server:", error);
      socket.emit("website-share-error", { error: "Invalid URL format" });
    }
  });

  socket.on("website-closed", ({ roomID, userID }) => {
    console.log(`User ${userID} closed website sharing in room: ${roomID}`);
    io.to(roomID).emit("website-closed", { userID, roomID });
  });

  // Messaging
  socket.on("message", ({ roomID, compressedMessage }) => {
    console.log("message:", compressedMessage ? "[compressed]" : "[empty]");
    socket.broadcast.to(roomID).emit("message", compressedMessage);
  });

  // Example: AI definition (keeps same behavior)
  socket.on("get-definition", async ({ question, userID }) => {
    console.log("Definition request:", question);
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const prompt = `Explain in simple words ${question}`;
      const result = await model.generateContent(prompt);
      const answer = result.response.text();
      // basic formatting
      const words = answer.split(" ");
      let formattedAnswer = "";
      for (let i = 0; i < words.length; i++) {
        if (i > 0 && i % 10 === 0) formattedAnswer += "\n";
        formattedAnswer += words[i] + " ";
      }
      socket.emit("got-definition", formattedAnswer.trim());
    } catch (err) {
      console.error("AI error:", err);
      socket.emit(
        "got-definition",
        "Sorry, couldn't fetch definition right now."
      );
    }
  });

  // Disconnect handling
  socket.on("disconnect", () => {
    if (socket.roomID && socket.userID) {
      if (rooms[socket.roomID]) {
        rooms[socket.roomID].users = rooms[socket.roomID].users.filter(
          (u) => u.socketId !== socket.id
        );
        // If room empty, optional cleanup (left commented for now)
        if (rooms[socket.roomID].users.length === 0) {
          console.log(`Room ${socket.roomID} is empty (no connected sockets).`);
          // delete rooms[socket.roomID]; // uncomment if you want auto-delete
        }
      }
      socket.broadcast
        .to(socket.roomID)
        .emit("user-disconnected", { userID: socket.userID });
      socket.broadcast
        .to(socket.roomID)
        .emit("cursor-position-removed", { userId: socket.userID });
      console.log(
        `User ${socket.userID} disconnected from room ${socket.roomID} and emiting cursor-position-removed`
      );
    } else {
      console.log(`Socket ${socket.id} disconnected (no tracked room/user).`);
    }
  });
});

// Simple REST endpoints for debug / minimal API
app.get("/", (req, res) => {
  res.send("Hello server is working");
});

app.get("/api/classes/:roomID", async (req, res) => {
  try {
    const { roomID } = req.params;

    const classDoc = await Classes.findOne({ roomID });
    console.log("Fetched class document:", JSON.stringify(classDoc));

    if (!classDoc) {
      return res.status(404).json({ error: "Class not found" });
    }

    res.json({
      roomID,
      title: classDoc.title,
      teacher: classDoc.teacher,
      date: classDoc.date,
      audioUrl: classDoc.AudioURL,
      slides: classDoc.slides,
    });
  } catch (err) {
    console.error("❌ Error fetching class:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/debug/rooms", (req, res) => {
  const roomStats = {};
  Object.keys(rooms).forEach((roomID) => {
    roomStats[roomID] = {
      slideCount: rooms[roomID].slides.length,
      currentSlide: rooms[roomID].currentSlide,
      userCount: rooms[roomID].users.length,
      users: rooms[roomID].users.map((u) => u.userID),
    };
  });
  res.json(roomStats);
});

const PORT = process.env.PORT || 3003;
server.listen(PORT, () => {
  console.log("server is running on port", PORT);
});
