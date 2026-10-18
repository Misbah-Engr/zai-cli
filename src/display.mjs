// Display-only escaping. Never rewrite the command or path submitted to a tool.
export const clean = value => String(value)
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
  .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
