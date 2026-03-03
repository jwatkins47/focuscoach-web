import axios from "axios";

export const api = axios.create({
  baseURL: "https://localhost:7029",
  headers: { "Content-Type": "application/json" }
});

export const TasksApi = {
  getAll: () => api.get("/api/tasks").then(r => r.data),
  create: (task) => api.post("/api/tasks", task).then(r => r.data),

  recommend: (req) => api.post("/api/tasks/recommend", req).then(r => r.data),
  breakdown: (id, req) => api.post(`/api/tasks/${id}/breakdown`, req).then(r => r.data),
};