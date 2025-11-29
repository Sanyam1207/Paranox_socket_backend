import mongoose from "mongoose";

// Each point in a pencil/eraser stroke
const pointSchema = new mongoose.Schema({
  x: Number,
  y: Number,
  t: Number, // timestamp relative to recording start
});

// Each element (pencil, rectangle, text, image, etc.)
const elementSchema = new mongoose.Schema({
  type: { type: String, required: true }, // PENCIL, RECTANGLE, TEXT, IMAGE, etc.
  points: [pointSchema], // only for pencil/eraser
  x1: Number,
  y1: Number,
  x2: Number,
  y2: Number,
  color: String,
  strokeWidth: Number,
  fill: Boolean,
  fillStyle: String,
  src: String, // for IMAGE
  text: String, // for TEXT
  startTime: Number, // timestamp relative to slide start
});

// Each slide contains multiple elements
const slideSchema = new mongoose.Schema({
  id: { type: String, required: true },
  title: String,
  elements: [elementSchema],
});

// Main Classes schema
const classesSchema = new mongoose.Schema({
  title: { type: String, required: true },
  roomID: { type: String, required: true },
  teacher: { type: String, required: true },
  date: { type: Date, required: true },
  AudioURL: { type: String },
  slides: [slideSchema], // <- whiteboard slides
  createdAt: { type: Date, default: Date.now },
  NotesURL: String,
  SummaryURL: String,
});

const Classes = mongoose.models.Classes || mongoose.model("Classes", classesSchema);

export default Classes;
