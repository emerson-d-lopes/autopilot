// Quick mode: a compact text protocol for long action sequences.
//
// A JSON tool call spends tokens on structure. `browser_batch` already collapses
// several actions into one round trip, but each action still costs a nested
// object. Quick mode expresses the same sequence as one line per action, so a
// single turn can emit a long script cheaply:
//
//   F ref_12 buyer@example.com
//   C ref_18
//   K Enter
//   W
//   R
//
// Targets are either a ref or an x y pair, so a script can mix element handles
// with screenshot coordinates.

export class QuickParseError extends Error {}

const TARGET_COMMANDS = {
  C: { action: 'left_click' },
  RC: { action: 'right_click' },
  DC: { action: 'double_click' },
  TC: { action: 'triple_click' },
  H: { action: 'hover' },
  SC: { action: 'scroll_to' },
};

const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

function parseTarget(parts, command, lineNo) {
  if (parts.length === 0) {
    throw new QuickParseError('line ' + lineNo + ': ' + command + ' needs a ref or x y coordinates');
  }
  if (/^ref_\d+$/.test(parts[0])) return { ref: parts[0] };
  if (parts.length < 2) {
    throw new QuickParseError('line ' + lineNo + ': ' + command + ' needs "ref_N" or "x y", got ' + parts.join(' '));
  }
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new QuickParseError('line ' + lineNo + ': ' + command + ' coordinates must be numbers');
  }
  return { coordinate: [x, y] };
}

/**
 * Turns a script into a list of {name, input} calls, the same shape browser_batch takes.
 * Parsing happens up front so a typo on the last line does not run the first nine.
 */
export function parseScript(script, tabId) {
  const actions = [];
  const lines = String(script || '').split('\n');
  // ST and NT retarget the lines that follow them.
  let currentTab = tabId;

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;

    const spaceAt = line.indexOf(' ');
    const command = (spaceAt === -1 ? line : line.slice(0, spaceAt)).toUpperCase();
    const rest = spaceAt === -1 ? '' : line.slice(spaceAt + 1).trim();
    const parts = rest ? rest.split(/\s+/) : [];
    const push = (name, input) => actions.push({ name, input: { ...input, tabId: currentTab }, lineNo, command });

    if (TARGET_COMMANDS[command]) {
      push('computer', { ...TARGET_COMMANDS[command], ...parseTarget(parts, command, lineNo) });
      return;
    }

    switch (command) {
      case 'T':
        push('computer', { action: 'type', text: rest });
        return;
      case 'TK':
        push('computer', { action: 'type', text: rest, perKey: true });
        return;
      // Types over whatever is already in the field. Without it, a pre-filled
      // input needs an explicit "K ctrl+a" first, and GitHub's file finder,
      // which puts a literal "t" in its own box, produced "tREADME".
      case 'TR':
        push('computer', { action: 'type', text: rest, replace: true });
        return;
      case 'K':
        if (!rest) throw new QuickParseError('line ' + lineNo + ': K needs a key, e.g. "K Enter"');
        push('computer', { action: 'key', text: rest });
        return;
      case 'S': {
        const direction = (parts[0] || 'down').toLowerCase();
        if (!DIRECTIONS.has(direction)) {
          throw new QuickParseError('line ' + lineNo + ': S direction must be up, down, left or right');
        }
        const amount = parts[1] ? Number(parts[1]) : 3;
        if (!Number.isFinite(amount)) {
          throw new QuickParseError('line ' + lineNo + ': S amount must be a number');
        }
        const input = { action: 'scroll', scroll_direction: direction, scroll_amount: amount };
        if (parts.length >= 4) input.coordinate = [Number(parts[2]), Number(parts[3])];
        push('computer', input);
        return;
      }
      case 'D': {
        if (parts.length < 4) {
          throw new QuickParseError('line ' + lineNo + ': D needs x1 y1 x2 y2');
        }
        const nums = parts.slice(0, 4).map(Number);
        if (nums.some((n) => !Number.isFinite(n))) {
          throw new QuickParseError('line ' + lineNo + ': D coordinates must be numbers');
        }
        push('computer', {
          action: 'left_click_drag',
          start_coordinate: [nums[0], nums[1]],
          coordinate: [nums[2], nums[3]],
        });
        return;
      }
      case 'Z': {
        if (parts.length < 4) throw new QuickParseError('line ' + lineNo + ': Z needs x0 y0 x1 y1');
        push('computer', { action: 'zoom', region: parts.slice(0, 4).map(Number) });
        return;
      }
      case 'N':
        if (!rest) throw new QuickParseError('line ' + lineNo + ': N needs a url, "back" or "forward"');
        push('navigate', { url: rest });
        return;
      case 'J':
        if (!rest) throw new QuickParseError('line ' + lineNo + ': J needs an expression');
        push('javascript', { code: rest });
        return;
      case 'W':
        push('wait_for_page', parts[0] ? { timeout: Number(parts[0]) } : {});
        return;
      case 'F': {
        if (parts.length < 2) {
          throw new QuickParseError('line ' + lineNo + ': F needs a ref and a value, e.g. "F ref_3 hello"');
        }
        if (!/^ref_\d+$/.test(parts[0])) {
          throw new QuickParseError('line ' + lineNo + ': F must target a ref, got ' + parts[0]);
        }
        const value = rest.slice(parts[0].length).trim();
        const coerced = value === 'true' ? true : value === 'false' ? false : value;
        push('form_input', { ref: parts[0], value: coerced });
        return;
      }
      // R [all] [max_chars]. The budget is a trailing number, so "R 30000" and
      // "R all 30000" both work and "R" keeps the tool's own default.
      case 'R': {
        const input = { filter: parts[0] === 'all' ? 'all' : 'interactive' };
        const budget = parts[parts.length - 1];
        if (parts.length && budget !== 'all') {
          const n = Number(budget);
          if (!Number.isFinite(n) || n <= 0) {
            throw new QuickParseError(
              'line ' + lineNo + ': R takes "all" and an optional character budget, got ' + JSON.stringify(budget)
            );
          }
          input.max_chars = n;
        }
        push('read_page', input);
        return;
      }
      case 'X':
        push('get_page_text', {});
        return;
      case 'SS':
        push('computer', { action: 'screenshot' });
        return;
      case 'P':
        push('page_state', {});
        return;
      case 'PAUSE':
        push('computer', { action: 'wait', duration: parts[0] ? Number(parts[0]) : 1 });
        return;
      case 'ST': {
        const id = Number(parts[0]);
        if (!Number.isFinite(id)) throw new QuickParseError('line ' + lineNo + ': ST needs a tab id');
        currentTab = id;
        push('page_state', {});
        return;
      }
      case 'NT':
        // The new tab has no id until it exists, so later lines carry a marker
        // the runner resolves against the tabs_create result.
        actions.push({ name: 'tabs_create', input: rest ? { url: rest } : {}, lineNo, command });
        currentTab = '$last';
        return;
      case 'LT':
        actions.push({ name: 'tabs_context', input: {}, lineNo, command });
        return;
      default:
        throw new QuickParseError(
          'line ' + lineNo + ': unknown command ' + JSON.stringify(command) +
            '. Supported: C RC DC TC H SC T TK TR K S D Z N J W F R X SS P PAUSE ST NT LT'
        );
    }
  });

  if (!actions.length) throw new QuickParseError('script contained no commands');
  return actions;
}
