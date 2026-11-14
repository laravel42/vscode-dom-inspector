import express from "express";
import cors from "cors";
import { SelectedDomNodeSchema, StyleChangeSchema } from "./types.js";
import {
  setCurrentSelection,
  getCurrentSelection,
  clearCurrentSelection,
  addStyleChange,
} from "./state.js";
import { BRIDGE_NAME } from "./bridge-mode.js";

const REQUEST_SIZE_LIMIT = "100kb";

export function createHttpApp(): express.Express {
  const app = express();

  app.use(cors({ origin: true }));

  // GET /health — lets other DOM Inspector MCP instances recognise this bridge
  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: BRIDGE_NAME, pid: process.pid });
  });
  app.use(express.json({ limit: REQUEST_SIZE_LIMIT }));

  // POST /selection — store a new selected DOM node
  app.post("/selection", (req, res) => {
    const result = SelectedDomNodeSchema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({
        ok: false,
        error: "Invalid payload",
        details: result.error.flatten().fieldErrors,
      });
      return;
    }

    const stored = setCurrentSelection(result.data);

    res.json({
      ok: true,
      selectedAt: stored.selectedAt,
      tagName: stored.node.tagName,
      selector: stored.node.selector,
    });
  });

  // GET /selection — return the current selection (debug)
  app.get("/selection", (_req, res) => {
    const sel = getCurrentSelection();
    if (!sel) {
      res.json({ ok: true, selection: null });
      return;
    }
    res.json({ ok: true, selection: sel });
  });

  // DELETE /selection — clear the current selection
  app.delete("/selection", (_req, res) => {
    clearCurrentSelection();
    res.json({ ok: true, cleared: true });
  });

  // POST /style-change — record a style change on the current selection
  app.post("/style-change", (req, res) => {
    const result = StyleChangeSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ ok: false, error: "Invalid payload", details: result.error.flatten().fieldErrors });
      return;
    }
    addStyleChange(result.data);
    res.json({ ok: true });
  });

  // Global error handler
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("[http] Unhandled error:", err.message);
      res.status(500).json({ ok: false, error: "Internal server error" });
    },
  );

  return app;
}
