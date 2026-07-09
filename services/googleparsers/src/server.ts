import express from "express";
import { runGoogleMapsJob } from "./parser/googleMapsParser.js";
import { runGoogleNewsJob } from "./parser/googleNewsParser.js";
import type {
  NewsScrapeSettings,
  ScrapeSettings,
  ScrapeJob,
  NewsJob
} from "./shared/types.js";
import { generateSearchTargets } from "./shared/googleMaps.js";
import { generateNewsTargets } from "./shared/googleNews.js";

const app = express();
app.use(express.json({ limit: "4mb" }));

const port = Number(process.env.PORT) || 8001;

type Control = { paused: boolean; stopped: boolean };
const controls = new Map<string, Control>();

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/run/maps", async (req, res) => {
  const { jobId, settings } = req.body as { jobId: string; settings: ScrapeSettings };
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");

  const control: Control = { paused: false, stopped: false };
  controls.set(jobId, control);

  const targets = generateSearchTargets(settings);
  const job: ScrapeJob = {
    id: jobId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    settings,
    targets,
    currentTargetIndex: 0,
    processedPlaces: 0,
    totalDiscovered: 0,
    message: "",
    results: [],
    errors: []
  };

  const emit = (kind: string, payload: unknown) => {
    res.write(`event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    await runGoogleMapsJob(job, {
      onPlaceFound: (place) => emit("place", place),
      onProgress: (progress) => emit("progress", progress),
      onError: (error) => emit("error", error),
      onLog: (level, message, meta) => emit("log", { level, message, meta }),
      shouldPause: () => control.paused,
      shouldStop: () => control.stopped
    });
    emit("done", { status: job.status, message: job.message });
  } catch (err) {
    emit("error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    controls.delete(jobId);
    res.end();
  }
});

app.post("/run/news", async (req, res) => {
  const { jobId, settings } = req.body as { jobId: string; settings: NewsScrapeSettings };
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");

  const control: Control = { paused: false, stopped: false };
  controls.set(jobId, control);

  const targets = generateNewsTargets(settings);
  const job: NewsJob = {
    id: jobId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    settings,
    targets,
    currentTargetIndex: 0,
    processedResults: 0,
    message: "",
    results: [],
    errors: []
  };

  const emit = (kind: string, payload: unknown) => {
    res.write(`event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    await runGoogleNewsJob(job, {
      onResult: (result) => emit("result", result),
      onProgress: (progress) => emit("progress", progress),
      onError: (error) => emit("error", error),
      onLog: (level, message, meta) => emit("log", { level, message, meta }),
      shouldPause: () => control.paused,
      shouldStop: () => control.stopped
    });
    emit("done", { status: job.status, message: job.message });
  } catch (err) {
    emit("error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    controls.delete(jobId);
    res.end();
  }
});

app.post("/control/:jobId/:action", (req, res) => {
  const control = controls.get(req.params.jobId);
  if (!control) return res.status(404).json({ error: "job not running" });
  const action = req.params.action;
  if (action === "pause") control.paused = true;
  else if (action === "resume") control.paused = false;
  else if (action === "stop") control.stopped = true;
  else return res.status(400).json({ error: "unknown action" });
  return res.json({ ok: true });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`googleparsers service listening on :${port}`);
});
