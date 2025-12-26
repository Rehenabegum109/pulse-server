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
  } catch (err) {
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
app.use((req, res, next) => {
  console.log(req.method, req.url);
  next();
});


// -------------------------
// Helper Functions
// -------------------------

function calculateHealth(project, risks = [], checkins = [], feedbacks = []) {
  let score = 100;

 
  const highRisks = risks.filter(r => r.severity === "High" && r.status === "Open").length;
  score -= highRisks * 10;

 
  const avgConfidence = checkins.length ? checkins.reduce((a,b)=>a+b.confidenceLevel,0)/checkins.length : 5;
  score = score * (avgConfidence/5);

 
  const avgSatisfaction = feedbacks.length ? feedbacks.reduce((a,b)=>a+b.satisfaction || 5,0)/feedbacks.length : 5;
  score = score * (avgSatisfaction/5);


  if(score > 100) score = 100;
  if(score < 0) score = 0;

  return Math.round(score);
}
function getCurrentWeek() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const diff = now - start + ((start.getDay() + 6) % 7) * 86400000;
  const week = Math.floor(diff / (7 * 86400000)) + 1;
  return `${now.getFullYear()}-W${week}`;
}

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

// -------------------------
// Batch Create Users Route
// -------------------------
app.post("/create-users", async (req, res) => {
  const users = req.body; // Expecting an array of users
  if (!Array.isArray(users)) {
    return res.status(400).send("Please send an array of users");
  }

  const createdUsers = [];

  for (let u of users) {
    const { name, email, password, role } = u;

    // check if user already exists
    const existing = await db.collection("users").findOne({ email });
    if (existing) continue; // Skip existing users

    const hashedPassword = await bcrypt.hash(password, 10);
    await db.collection("users").insertOne({ name, email, password: hashedPassword, role });
    createdUsers.push(email);
  }

  res.json({ message: "Users created", users: createdUsers });
});




app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db.collection('users').findOne({ email });
  if (!user) return res.status(400).json({ message: 'Invalid credentials' });
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });
  
  const token = jwt.sign({ id: user._id.toString(), role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user._id.toString(), name: user.name, role: user.role } });
});


// Get logged-in user profile
app.get("/api/auth/me", protect, async (req, res) => { 
  const { _id, name, email, role } = req.user;
  res.json({ id: _id, name, email, role });
});

app.post('/api/projects', protect, authorize('admin'), async (req, res) => {
  const { name, description, startDate, endDate, clientId, employeeIds } = req.body;

  const project = {
    name,
    description,
    startDate: new Date(startDate),
    endDate: new Date(endDate),
    client: new ObjectId(clientId),
    employees: employeeIds.map(id => new ObjectId(id)),
    status: 'On Track',
    healthScore: 100,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const result = await db.collection('projects').insertOne(project);
  res.status(201).json({ message: 'Project created', projectId: result.insertedId });
});


app.get("/api/projects", protect, async (req, res) => {
  try {
    const userId = req.user._id.toString(); 

    let projects;

    if (req.user.role === "admin") {
      
      projects = await db.collection("projects").find().toArray();

    } else if (req.user.role === "employee") {
      
      projects = await db.collection("projects").find({
        employees: userId
      }).toArray();

    } else if (req.user.role === "client") {

      projects = await db.collection("projects").find({
        client: userId
      }).toArray();

    } else {
      return res.status(403).json({ message: "Access denied" });
    }

    // console.log("Fetched Projects:", projects);
    res.json(projects);

  } catch (err) {
    console.error("Error fetching projects:", err);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/api/projects/:projectId", protect, async (req,res)=>{
  try {
    const id = req.params.projectId;

    const project = await db.collection("projects").findOne({
      _id: new ObjectId(id)
    });

    if (!project) return res.status(404).json({ message: "Project not found" });

    res.json(project);

  } catch (err) {
    return res.status(400).json({ message: "Invalid Project ID" });
  }
});
app.get("/api/employee/projects", protect, authorize("employee"), async (req,res)=>{
  try {
    const userId = req.user._id.toString();
    const projects = await db.collection("projects").find({
      employees: userId
    }).toArray();
    res.json(projects);
  } catch(err){
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});


app.get('/api/admin/projects', protect, authorize('admin'), async (req,res)=>{
  try {
    const projects = await db.collection('projects').find().toArray();
    const risks = await db.collection('risks').find().toArray();
    const checkins = await db.collection('checkins').find().toArray();
    const feedbacks = await db.collection('feedbacks').find().toArray();

    const result = projects.map(p=>{
      const projectRisks = risks.filter(r=>r.projectId === p._id.toString());
      const projectCheckins = checkins.filter(c=>c.projectId === p._id.toString());
      const projectFeedbacks = feedbacks.filter(f=>f.projectId === p._id.toString());

      return {
        ...p,
        openRisksCount: projectRisks.filter(r=>r.status==='Open').length,
        healthScore: calculateHealth(p, projectRisks, projectCheckins, projectFeedbacks)
      };
    });

    res.json(result);
  } catch(err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});


// GET all feedbacks for a project
app.get("/api/projects/:id/feedbacks", protect, async (req, res) => {
  try {
    const projectId = req.params.id;
    const feedbacks = await db.collection("feedbacks")
      .find({ projectId })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(feedbacks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch feedbacks" });
  }
});
app.post("/api/projects/:id/feedbacks", protect, authorize("client"), async (req, res) => {
  try {
    const projectId = req.params.id;
    const { satisfactionRating, communicationRating, comments, flagIssue } = req.body;

    const feedback = {
      projectId,
      userId: req.user._id.toString(),
      userName: req.user.name || req.user.email,
      satisfactionRating: Number(satisfactionRating),
      communicationRating: Number(communicationRating),
      comments: comments || "",
      flagIssue: flagIssue || false,
      week: getCurrentWeek(), // Optional: current week
      createdAt: new Date()
    };

    await db.collection("feedbacks").insertOne(feedback);
    res.status(201).json({ message: "Feedback submitted", feedback });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to submit feedback" });
  }
});




app.put("/api/projects/:id", protect, authorize("admin"), async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;

  const result = await db.collection("projects").updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...updateData, updatedAt: new Date() } }
  );

  if (result.matchedCount === 0) return res.status(404).json({ message: "Project not found" });
  res.json({ message: "Project updated" });
});

app.delete('/api/projects/:id', protect, authorize('admin'), async (req, res) => {
  const { id } = req.params;
  await db.collection('projects').deleteOne({ _id: new ObjectId(id) });
  res.json({ message: 'Project deleted' });
});


//  Employee Weekly Check-in
// routes/checkins.js
app.post("/api/checkins", protect, authorize("employee"), async (req,res)=>{
  const { projectId, progressSummary, blockers, confidenceLevel, completionPercentage } = req.body;

  if (!projectId) return res.status(400).json({ message: "ProjectId is required" });

  const checkin = {
    projectId,
    employeeId: req.user._id.toString(),
    week: getCurrentWeek(),   
    progressSummary,
    blockers,
    confidenceLevel,
    completionPercentage,
    createdAt: new Date()
  };

  await db.collection("checkins").insertOne(checkin);
  res.status(201).json({ message: "Check-in submitted" });
});



app.get("/api/checkins/:projectId", protect, async (req,res)=>{
  const { projectId } = req.params;

  const checkins = await db.collection("checkins").find({ projectId }).toArray();
  res.json(checkins);
});
app.get("/api/employee/checkins/pending", protect, authorize("employee"), async (req,res)=>{
  try {
    const userId = req.user._id.toString();
    const projects = await db.collection("projects").find({ employees: userId }).toArray();
    const currentWeek = getCurrentWeek();
    const pending = [];

    for(const p of projects){
      const existing = await db.collection("checkins").findOne({
        projectId: p._id.toString(),
        employeeId: userId,
        week: currentWeek
      });
      if(!existing){
        pending.push({ projectId: p._id.toString(), projectName: p.name, week: currentWeek });
      }
    }

    res.json(pending);
  } catch(err){
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});


app.get('/api/admin/projects/missing-checkins', protect, authorize('admin'), async (req,res)=>{
  try{
    const projects = await db.collection('projects').find().toArray();
    const week = getCurrentWeek();
    const checkins = await db.collection('checkins').find({week}).toArray();

    const missing = projects.filter(p=>{
      return !checkins.some(c=>c.projectId === p._id.toString());
    });

    res.json(missing);
  } catch(err){
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
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

// GET all feedbacks for a project
app.get("/api/feedbacks/:projectId", protect, async (req, res) => {
  const projectId = req.params.projectId;

  try {
    const feedbacks = await db.collection("feedbacks")
      .find({ projectId })
      .toArray();

    res.status(200).json(feedbacks);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/projects/assigned
app.get("/api/projects/assigned", protect, async (req, res) => {
  try {
    if (req.user.role !== "employee") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const userId = req.user._id.toString();

    // Projects where employee is assigned
    const projects = await db.collection("projects")
      .find({ employeeIds: userId })
      .toArray();

    res.json(projects);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch assigned projects" });
  }
});





//  Health Score Calculation (Admin)
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

// Risk management
app.get("/api/risks", protect, async (req, res) => {
  try {
    let query = {};

    if (req.user.role === "employee") {
      query.employeeId = req.user._id.toString();
    }

    const risks = await db.collection("risks")
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.json(risks);

  } catch (error) {
    res.status(500).json({ message: "Failed to fetch risks" });
  }
});


app.post("/api/risks", protect, authorize("employee"), async (req, res) => {
  try {
    const { projectId, title, severity, mitigationPlan, status } = req.body;

    await db.collection("risks").insertOne({
      projectId,
      title,
      severity, 
      mitigationPlan,
      status: status || "Open",
      employeeId: req.user._id.toString(),
      createdAt: new Date()
    });

    res.status(201).json({ message: "Risk submitted successfully" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to submit risk" });
  }
});


app.get('/api/admin/projects/high-risk', protect, authorize('admin'), async (req,res)=>{
  try{
    const risks = await db.collection('risks').find({status:'Open', severity:'High'}).toArray();
    const projectIds = [...new Set(risks.map(r=>r.projectId))];
    const projects = await db.collection('projects').find({_id: {$in: projectIds.map(id=>new ObjectId(id))}}).toArray();
    res.json(projects);
  } catch(err){
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// -------------------------
// Start Server
// -------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
