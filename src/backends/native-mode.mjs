import { isRecord } from '../util.mjs';

export const NATIVE_MODES = Object.freeze({ ask: 'guarded', yolo: 'yolo', 'read-only': 'plan' });
const WIRE_MODES = new Set(['plan', 'build', 'edit', 'guarded', 'yolo', 'auto']);

/** Read acknowledged runtime state, never infer success from the requested mode. */
export function snapshotPermissionMode(snapshot, sessionId) {
  if (!isRecord(snapshot) || snapshot.session?.sessionId !== sessionId) {
    throw new Error('Permission snapshot belongs to a different session.');
  }
  // Upstream maps session.mode from a reducer projection, which can lag app.getMode().
  // settings.permission.mode and settings.mode.current are the live app values.
  const permission = snapshot.settings?.permission?.mode;
  const setting = snapshot.settings?.mode?.current;
  if (permission !== undefined && setting !== undefined && permission !== setting) {
    throw new Error('Runtime reported conflicting permission modes.');
  }
  const mode = permission ?? setting ?? snapshot.session.mode;
  if (!WIRE_MODES.has(mode)) throw new Error('Runtime did not report a recognized permission mode.');
  return mode;
}

export function localPermissionMode(runtimeMode) {
  return runtimeMode === 'yolo' ? 'yolo' : runtimeMode === 'guarded' ? 'ask'
    : runtimeMode === 'plan' ? 'read-only' : runtimeMode;
}

export function fullAccessConfirmation(cwd) {
  return {
    title: 'Enable full access for this session?',
    allowLabel: 'Enable YOLO',
    risk: 'full access',
    detail: 'YOLO lets the native runtime edit or delete files, run commands, and use the network without ordinary permission prompts. It runs with your operating-system user permissions, not in an OS sandbox.',
    input: `Workspace: ${cwd}\n\nAccess is NOT confined to this folder. Use a disposable project copy without valuable credentials.\n\nThis changes the current session only. New or resumed ZC sessions require fresh consent. /mode ask returns to guarded runtime policy, which may still auto-allow routine actions.\n\nRuntime-required confirmations and planning restrictions remain in effect. No prompt is submitted by this mode change.`,
  };
}
