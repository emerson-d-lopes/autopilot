// Claude in Chrome compatibility.
//
// Claude Code's own browser integration names a few tools and arguments
// differently. A model that has driven that extension writes those names from
// habit, most often inside a browser_batch, and a batch that fails on its first
// item because of a spelling costs a whole turn. Every call passes through here
// so both vocabularies work.

const TOOL_ALIASES = {
  tabs_context_mcp: 'tabs_context',
  tabs_create_mcp: 'tabs_create',
  tabs_close_mcp: 'tabs_close',
  javascript_tool: 'javascript',
};

const GIF_ACTIONS = {
  start_recording: 'start',
  stop_recording: 'stop',
  export: 'stop',
  clear: 'cancel',
};

function rename(input, from, to) {
  if (input[from] !== undefined && input[to] === undefined) input[to] = input[from];
  delete input[from];
}

/** Escapes a plain substring so it can stand in for a regular expression. */
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Maps a call written for Claude in Chrome onto this server's tools.
 * Returns the same shape browser_batch takes. Unknown names pass through
 * untouched so the usual "unknown tool" error still names what was sent.
 */
export function normalizeCall(name, input) {
  const tool = TOOL_ALIASES[name] || name;
  const args = { ...(input || {}) };

  switch (tool) {
    case 'javascript':
      // javascript_tool takes { action: "javascript_exec", text }.
      rename(args, 'text', 'code');
      delete args.action;
      break;
    case 'read_console_messages':
      rename(args, 'onlyErrors', 'only_errors');
      break;
    case 'read_network_requests':
      // urlPattern is a substring match there, url_pattern a regex here.
      if (args.urlPattern !== undefined && args.url_pattern === undefined) {
        args.url_pattern = escapeRegex(args.urlPattern);
      }
      delete args.urlPattern;
      break;
    case 'select_browser':
    case 'switch_browser':
      rename(args, 'deviceId', 'browserId');
      break;
    case 'shortcuts_execute':
      rename(args, 'command', 'shortcutId');
      break;
    case 'gif_creator':
      if (GIF_ACTIONS[args.action]) args.action = GIF_ACTIONS[args.action];
      // download is how that extension hands the file over. Here the file is
      // always written to disk and its path reported, so the flag is moot.
      delete args.download;
      break;
    default:
      break;
  }

  return { name: tool, input: args };
}

export const CLAUDE_IN_CHROME_TOOL_ALIASES = Object.freeze({ ...TOOL_ALIASES });
