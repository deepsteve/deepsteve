const { z } = require('zod');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

// Pending requests awaiting browser response: requestId → { resolve, timer }
const pendingRequests = new Map();

const TIMEOUT_MS = 30000; // 30s — snapshots can be slow

/**
 * Initialize Three.js scene MCP tools.
 */
function init(context) {
  const { broadcast, broadcastToWindow, shells } = context;

  // Resolve session_id to a windowId, returning the send function
  function resolveTarget(session_id) {
    if (session_id) {
      const shell = shells.get(session_id);
      if (shell && shell.windowId) {
        const windowId = shell.windowId;
        return { send: (msg) => broadcastToWindow(windowId, { ...msg, targetWindowId: windowId }) };
      }
    }
    return { send: broadcast };
  }

  return {
    scene_update: {
      description: 'Add, update, or remove objects in a 3D scene. Takes a batch of operations so you can build complex scenes in one call. Use eval to run arbitrary Three.js code (animate, create particles, etc). Make sure the 3D Scene mod is enabled in deepsteve.',
      schema: {
        operations: z.array(z.object({
          op: z.enum(['add', 'update', 'remove', 'clear', 'eval']).describe('Operation type'),
          id: z.string().optional().describe('Object ID (required for add/update/remove)'),
          type: z.enum([
            'box', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'line', 'group',
            'ambient_light', 'directional_light', 'point_light', 'spot_light',
            'camera', 'text',
          ]).optional().describe('Object type (required for add)'),
          geometry: z.record(z.any()).optional().describe('Geometry params: {width, height, depth} for box, {radius} for sphere, {radiusTop, radiusBottom, height} for cylinder, etc.'),
          material: z.record(z.any()).optional().describe('Material params: {color, opacity, wireframe, metalness, roughness, emissive}'),
          position: z.array(z.number()).optional().describe('[x, y, z] position'),
          rotation: z.array(z.number()).optional().describe('[x, y, z] rotation in radians'),
          scale: z.array(z.number()).optional().describe('[x, y, z] scale'),
          light: z.record(z.any()).optional().describe('Light params: {color, intensity, castShadow, distance, decay, angle, penumbra}'),
          camera: z.record(z.any()).optional().describe('Camera params: {fov, position, lookAt}'),
          text: z.record(z.any()).optional().describe('Text params: {content, fontSize, color, backgroundColor}'),
          code: z.string().optional().describe('JS code for eval op. Available context: THREE, scene, camera, renderer, registry, clock, controls, canvas, onFrame(id, fn(dt,t)), removeFrame(id), frameCallbacks'),
          visible: z.boolean().optional().describe('Whether the object is visible'),
          castShadow: z.boolean().optional().describe('Whether the object casts shadows'),
          receiveShadow: z.boolean().optional().describe('Whether the object receives shadows'),
          parent: z.string().optional().describe('Parent group ID'),
        })).describe('Array of scene operations to execute in order'),
        session_id: z.string().optional().describe('DeepSteve session ID ($DEEPSTEVE_SESSION_ID). When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ operations, session_id }) => {
        const requestId = randomUUID();
        const { send } = resolveTarget(session_id);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for browser response. Make sure the 3D Scene mod is enabled in the deepsteve browser tab.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer });

          send({
            type: 'scene-update-request',
            requestId,
            operations,
          });
        });
      },
    },

    scene_query: {
      description: 'List objects and inspect scene state. Returns all objects with positions/types, or one object\'s full details if id is provided. Make sure the 3D Scene mod is enabled in deepsteve.',
      schema: {
        id: z.string().optional().describe('Object ID to inspect. If omitted, returns all objects.'),
        session_id: z.string().optional().describe('DeepSteve session ID ($DEEPSTEVE_SESSION_ID). When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ id, session_id }) => {
        const requestId = randomUUID();
        const { send } = resolveTarget(session_id);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for browser response. Make sure the 3D Scene mod is enabled in the deepsteve browser tab.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer });

          send({
            type: 'scene-query-request',
            requestId,
            id: id || null,
          });
        });
      },
    },

    scene_snapshot: {
      description: 'Capture the current 3D scene as a PNG image. Optionally saves to a file. Make sure the 3D Scene mod is enabled in deepsteve.',
      schema: {
        width: z.number().optional().describe('Snapshot width in pixels. Defaults to current canvas width.'),
        height: z.number().optional().describe('Snapshot height in pixels. Defaults to current canvas height.'),
        filename: z.string().optional().describe('Output filename (without extension). If provided, saves PNG to output_dir.'),
        output_dir: z.string().optional().describe('Directory to save the PNG. Defaults to ~/Desktop.'),
        session_id: z.string().optional().describe('DeepSteve session ID ($DEEPSTEVE_SESSION_ID). When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ width, height, filename, output_dir, session_id }) => {
        const requestId = randomUUID();
        const { send } = resolveTarget(session_id);

        // Pre-compute output path if filename provided
        let outPath = null;
        if (filename) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const fname = (filename || `scene-${ts}`) + '.png';
          const dir = output_dir || path.join(require('os').homedir(), 'Desktop');
          outPath = path.join(dir, fname);
        }

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for browser response. Make sure the 3D Scene mod is enabled in the deepsteve browser tab.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer, outPath });

          send({
            type: 'scene-snapshot-request',
            requestId,
            width: width || null,
            height: height || null,
          });
        });
      },
    },
  };
}

/**
 * Register REST routes for receiving scene results.
 */
function registerRoutes(app, context) {
  const express = require('express');

  // Scene update/query results (JSON)
  app.post('/api/threejs-scene/result', express.json({ limit: '50mb' }), (req, res) => {
    const { requestId, result, dataUrl, error } = req.body;

    if (!requestId) {
      return res.status(400).json({ error: 'Missing requestId' });
    }

    const pending = pendingRequests.get(requestId);
    if (!pending) {
      return res.json({ accepted: false });
    }

    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);

    if (error) {
      pending.resolve({
        content: [{ type: 'text', text: `Error: ${error}` }],
      });
    } else if (dataUrl && pending.outPath) {
      // Snapshot with file save
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
        pending.resolve({
          content: [{ type: 'text', text: 'Error: Invalid or missing dataUrl — expected a data:image/png;base64,… string' }],
        });
        return res.status(400).json({ error: 'Invalid dataUrl' });
      }
      try {
        const base64 = dataUrl.slice('data:image/png;base64,'.length);
        const buf = Buffer.from(base64, 'base64');
        if (buf.length === 0) {
          pending.resolve({
            content: [{ type: 'text', text: 'Error: Snapshot data decoded to an empty buffer' }],
          });
          return res.status(400).json({ error: 'Empty image data' });
        }
        fs.mkdirSync(path.dirname(pending.outPath), { recursive: true });
        fs.writeFileSync(pending.outPath, buf);
        pending.resolve({
          content: [{ type: 'text', text: `Scene snapshot saved to ${pending.outPath}` }],
        });
      } catch (e) {
        pending.resolve({
          content: [{ type: 'text', text: `Error saving snapshot: ${e.message}` }],
        });
      }
    } else if (dataUrl) {
      // Snapshot without file save — return base64 info
      pending.resolve({
        content: [{ type: 'text', text: `Scene snapshot captured (${Math.round(dataUrl.length / 1024)}KB base64). Use filename parameter to save to disk.` }],
      });
    } else {
      // Update/query result — return as text
      pending.resolve({
        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
      });
    }

    res.json({ accepted: true });
  });
}

module.exports = { init, registerRoutes };
