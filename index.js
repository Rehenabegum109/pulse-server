// index.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// -------------------------
// MongoDB Connection
// -------------------------
let db;
const client = new MongoClient(process.env.MONGO_URI);

async function connectDB() {
  try {
    await client.connect();
    db = client.db("projectpulse");
    console.log("MongoDB connected");
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
connectDB();

// -------------------------
// Middleware: Protect Routes
// -------------------------
const protect = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await db.collection("users").findOne({ _id: new ObjectId(decoded.id) });
    if (!user) return res.status(401).json({ message: "User not found" });

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ message: "Invalid token" });
  }
};

// -------------------------
// Middleware: Role Authorization
// -------------------------
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied" });
    }
    next();
  };
};

// -------------------------
// Routes
// -------------------------

// Test route
app.get("/api", (req, res) => {
  res.json({ message: "API is working!" });
});
// 1️⃣ Seed Admin
app.get("/seed-admin", async (req, res) => {
  const existing = await db.collection("users").findOne({ email: "admin@example.com" });
  if (existing) return res.send("Admin already exists");

  const hashedPassword = await bcrypt.hash("admin123", 10);
  await db.collection("users").insertOne({
    name: "Admin",
    email: "admin@example.com",
    password: hashedPassword,
    role: "admin",
  });
  res.send("Admin user created");
});

// 2️⃣ Seed Employees & Clients
app.get("/seed-users", async (req, res) => {
  const users = [
    { name: "Employee1", email: "emp1@example.com", password: await bcrypt.hash("emp123", 10), role: "employee" },
    { name: "Employee2", email: "emp2@example.com", password: await bcrypt.hash("emp123", 10), role: "employee" },
    { name: "Client1", email: "client1@example.com", password: await bcrypt.hash("client123", 10), role: "client" },
  ];
  await db.collection("users").insertMany(users);
  res.send("Employees & Clients created");
});




// 3️⃣ Login
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await db.collection("users").findOne({ email });
  if (!user) return res.status(400).json({ message: "Invalid credentials" });

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });

  const token = jwt.sign({ id: user._id.toString(), role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user._id, name: user.name, role: user.role } });
});

// 4️⃣ Create Project (Admin only)
app.post("/api/projects", protect, authorize("admin"), async (req, res) => {
  const { name, description, startDate, endDate, clientId, employeeIds } = req.body;
  if (!name || !description || !startDate || !endDate || !clientId || !employeeIds) {
    return res.status(400).json({ message: "All fields are required" });
  }

  const project = {
    name,
    description,
    startDate: new Date(startDate),
    endDate: new Date(endDate),
    client: clientId,
    employees: employeeIds,
    status: "On Track",
    healthScore: 100,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const result = await db.collection("projects").insertOne(project);
  res.status(201).json({ message: "Project created", projectId: result.insertedId });
});

// 5️⃣ Get Projects (Role-based)
app.get("/api/projects", protect, async (req, res) => {
  let projects;
  if (req.user.role === "admin") {
    projects = await db.collection("projects").find().toArray();
  } else if (req.user.role === "employee") {
    projects = await db.collection("projects").find({ employees: req.user._id.toString() }).toArray();
  } else if (req.user.role === "client") {
    projects = await db.collection("projects").find({ client: req.user._id.toString() }).toArray();
  } else {
    return res.status(403).json({ message: "Access denied" });
  }
  res.json(projects);
});

// // Update Project (Admin)
// app.put("/api/projects/:id", protect, authorize("admin"), async (req, res) => {
//   const id = req.params.id;

//   await db.collection("projects").updateOne(
//     { _id: new ObjectId(id) },
//     { $set: { ...req.body, updatedAt: new Date() } }
//   );

//   const updated = await db.collection("projects").findOne({ _id: new ObjectId(id) });
//   res.json(updated);
// });

// // Delete Project (Admin)
// app.delete("/api/projects/:id", protect, authorize("admin"), async (req, res) => {
//   await db.collection("projects").deleteOne({ _id: new ObjectId(req.params.id) });
//   res.json({ message: "Project deleted" });
// });


// 6️⃣ Employee Weekly Check-in
app.post("/api/checkins", protect, authorize("employee"), async (req,res)=>{
  const { projectId, week, progressSummary, blockers, confidenceLevel, completionPercentage } = req.body;
  const checkin = {
    projectId,
    employeeId: req.user._id.toString(),
    week,
    progressSummary,
    blockers,
    confidenceLevel,
    completionPercentage,
    createdAt: new Date()
  };
  await db.collection("checkins").insertOne(checkin);
  res.status(201).json({ message: "Check-in submitted" });
});

// 7️⃣ Client Feedback
app.post("/api/feedbacks", protect, authorize("client"), async (req,res)=>{
  const { projectId, satisfactionRating, communicationRating, comments, flaggedIssue } = req.body;
  const feedback = {
    projectId,
    clientId: req.user._id.toString(),
    satisfactionRating,
    communicationRating,
    comments: comments || "",
    flaggedIssue: flaggedIssue || false,
    createdAt: new Date()
  };
  await db.collection("feedbacks").insertOne(feedback);
  res.status(201).json({ message: "Feedback submitted" });
});

// 8️⃣ Health Score Calculation (Admin)
app.get("/api/projects/:id/health", protect, authorize("admin"), async (req,res)=>{
  const projectId = req.params.id;
  const project = await db.collection("projects").findOne({ _id: new ObjectId(projectId) });
  if(!project) return res.status(404).json({ message: "Project not found" });

  const feedbacks = await db.collection("feedbacks").find({ projectId }).toArray();
  const avgClient = feedbacks.length ? feedbacks.reduce((a,b)=>a+b.satisfactionRating,0)/feedbacks.length : 5;

  const checkins = await db.collection("checkins").find({ projectId }).toArray();
  const avgConf = checkins.length ? checkins.reduce((a,b)=>a+b.confidenceLevel,0)/checkins.length : 5;
  const avgCompletion = checkins.length ? checkins.reduce((a,b)=>a+b.completionPercentage,0)/checkins.length : 0;
  const flaggedCount = feedbacks.filter(f=>f.flaggedIssue).length;

  let healthScore = Math.round(avgClient*20*0.4 + avgConf*20*0.4 + avgCompletion*0.2 - flaggedCount*5);
  if(healthScore>100) healthScore=100;
  if(healthScore<0) healthScore=0;

  let status = "On Track";
  if(healthScore<60) status="Critical";
  else if(healthScore<80) status="At Risk";

  await db.collection("projects").updateOne(
    { _id: new ObjectId(projectId) },
    { $set: { healthScore, status, updatedAt: new Date() } }
  );

  res.json({ healthScore, status });
});

// -------------------------
// Start Server
// -------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
