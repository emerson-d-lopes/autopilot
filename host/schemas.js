// MCP tool definitions.
//
// Descriptions are part of the product. They steer when a tool gets reached for
// and what the model does when one fails, so they carry the recovery hints
// rather than leaving the model to guess.

const tabIdProp = {
  type: 'number',
  description: 'Tab to act on. Must be a tab in this session\'s group. Call tabs_context first if you do not have one.',
};

// Per-call routing. Present on every page tool so a session driving one profile
// can read another without switching and switching back. Tab ids are per
// browser, so a routed call needs a tabId from that browser's tabs_context.
const browserProp = {
  type: 'string',
  description:
    'Run this one call against another connected browser, without changing the session default. ' +
    'Takes an id or label from list_connected_browsers, or "profile=Work", "account=me@example.com", "site=linkedin.com".',
};

export const TOOLS = [
  {
    name: 'tabs_context',
    description:
      'List the tabs this session owns. Call this once before any other browser tool so you have a valid tabId. ' +
      'Each conversation works in its own tab group; pass createIfEmpty to open a blank tab in the current window when the group is empty.',
    inputSchema: {
      type: 'object',
      properties: {
        createIfEmpty: {
          type: 'boolean',
          description: 'Open a blank tab in the current window when this session has no tabs yet.',
        },
        browser: browserProp,
      },
    },
  },
  {
    name: 'tabs_create',
    description: 'Open a new tab in this session\'s tab group and wait for it to load.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open. Defaults to about:blank. A bare host gets https://.' },
        browser: browserProp,
      },
    },
  },
  {
    name: 'tabs_close',
    description: 'Close a tab in this session\'s tab group.',
    inputSchema: {
      type: 'object',
      properties: { tabId: tabIdProp, browser: browserProp },
      required: ['tabId'],
    },
  },
  {
    name: 'navigate',
    description:
      'Navigate a tab to a URL, or move through history with "back" or "forward". Waits for the load to finish. ' +
      'Element refs from a previous read_page do not survive navigation, so read the page again afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute or bare URL, or "back" / "forward".' },
        tabId: tabIdProp,
        browser: browserProp,
      },
      required: ['url', 'tabId'],
    },
  },
  {
    name: 'read_page',
    description:
      'Read the page as an accessibility tree. This is the primary way to see a page: it is far cheaper than a ' +
      'screenshot and returns [ref_N] handles you can pass to computer, form_input, and scroll_to, which stay ' +
      'correct even if the page reflows. Use filter "interactive" when you only need things you can act on. ' +
      'If the result is truncated it reports the full size; narrow it with ref_id to read one subtree, or lower depth, ' +
      'rather than raising max_chars blindly.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProp,
        filter: {
          type: 'string',
          enum: ['interactive', 'all'],
          description: '"interactive" returns only buttons, links, inputs and other actionable nodes. Default "all".',
        },
        depth: { type: 'number', description: 'Maximum tree depth. Default 15. Lower it when output is too large.' },
        ref_id: { type: 'string', description: 'Read only this element and its descendants, e.g. "ref_42".' },
        max_chars: { type: 'number', description: 'Output budget in characters. Default 50000.' },
        browser: browserProp,
      },
      required: ['tabId'],
    },
  },
  {
    name: 'get_page_text',
    description:
      'Extract readable text, preferring article or main content. Use this for reading prose. ' +
      'Use read_page instead when you need to interact with anything.',
    inputSchema: {
      type: 'object',
      properties: { tabId: tabIdProp, max_chars: { type: 'number', description: 'Default 50000.' }, browser: browserProp },
      required: ['tabId'],
    },
  },
  {
    name: 'find',
    description:
      'Find elements by describing them, e.g. "search bar", "login button", "row containing Acme Corp". ' +
      'Returns up to 20 ranked matches with refs. Cheaper than reading the whole tree when you know what you want. ' +
      'If nothing matches, fall back to read_page.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language description of the element.' },
        tabId: tabIdProp,
        include_all: {
          type: 'boolean',
          description: 'Search all elements rather than only interactive ones. Use for text and headings.',
        },
        browser: browserProp,
      },
      required: ['query', 'tabId'],
    },
  },
  {
    name: 'form_input',
    description:
      'Set the value of a form control by ref. Handles text inputs, textareas, selects, checkboxes and radios, and ' +
      'fires the events frameworks listen for. Prefer this over clicking and typing for form fields: it is one call ' +
      'and it cannot miss the target. For a select, value matches either the option value or its visible text.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from read_page or find, e.g. "ref_12".' },
        value: {
          type: ['string', 'boolean', 'number'],
          description: 'Text for inputs, option value or label for selects, boolean for checkboxes and radios.',
        },
        tabId: tabIdProp,
        browser: browserProp,
      },
      required: ['ref', 'value', 'tabId'],
    },
  },
  {
    name: 'computer',
    description:
      'Mouse and keyboard control, plus screenshots. Prefer targeting elements by "ref" from read_page or find over ' +
      'raw coordinates: refs survive reflow and cannot land on the wrong element. Reach for a screenshot when you need ' +
      'to see layout, an image, or a canvas, not as the default way to look at a page. ' +
      'Coordinates you pass are interpreted against the most recent screenshot of that tab.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'left_click', 'right_click', 'double_click', 'triple_click', 'hover',
            'type', 'key', 'screenshot', 'zoom', 'wait', 'scroll', 'scroll_to', 'left_click_drag',
          ],
          description:
            'left_click / right_click / double_click / triple_click: click at ref or coordinate. ' +
            'hover: move the pointer without clicking, to open menus and tooltips. ' +
            'type: insert text, optionally clicking ref first. key: press keys such as "Enter" or "ctrl+a". ' +
            'screenshot: capture the viewport. zoom: capture one region closely. scroll: wheel scroll. ' +
            'scroll_to: bring a ref into view. left_click_drag: press, move, release. wait: pause.',
        },
        tabId: tabIdProp,
        ref: { type: 'string', description: 'Target element ref. Preferred over coordinate for anything in the DOM.' },
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: '[x, y] in the coordinate space of the last screenshot of this tab.',
        },
        start_coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'Drag origin for left_click_drag.',
        },
        region: {
          type: 'array',
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
          description: '[x0, y0, x1, y1] region for zoom.',
        },
        text: {
          type: 'string',
          description: 'Text for "type", or the key combination for "key" (space-separate several, e.g. "Tab Tab Enter").',
        },
        perKey: {
          type: 'boolean',
          description: 'For "type": send individual key events instead of inserting the string at once. Needed by inputs that only react to keystrokes, such as autocompletes.',
        },
        modifiers: { type: 'string', description: 'Held modifiers, e.g. "ctrl", "shift", "ctrl+shift".' },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'number', description: 'Wheel ticks. Default 3.' },
        repeat: { type: 'number', description: 'Repeat a key sequence up to 100 times.' },
        duration: { type: 'number', description: 'Seconds to wait, maximum 10.' },
        save_to_disk: {
          type: 'boolean',
          description:
            'For screenshot and zoom: also write the image to a file and report the path, so it can be attached to a message. Skip it for images you only need to look at.',
        },
        browser: browserProp,
      },
      required: ['action', 'tabId'],
    },
  },
  {
    name: 'javascript',
    description:
      'Evaluate JavaScript in the page. The last expression is returned, and top-level await works. ' +
      'Use it to read state the accessibility tree does not expose, not as a substitute for clicking, since ' +
      'script-driven clicks skip the handlers real input triggers. Never trigger alert, confirm, or prompt: ' +
      'a modal dialog blocks every later browser call until a human dismisses it.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript to evaluate in the page context.' },
        tabId: tabIdProp,
        browser: browserProp,
      },
      required: ['code', 'tabId'],
    },
  },
  {
    name: 'read_console_messages',
    description:
      'Read console output captured since the tab joined this session, including errors thrown before you looked. ' +
      'Console output is verbose, so filter with pattern or only_errors rather than reading everything.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProp,
        only_errors: { type: 'boolean', description: 'Return only errors and assertions.' },
        pattern: { type: 'string', description: 'Case-insensitive regular expression filter on message text.' },
        limit: { type: 'number', description: 'Most recent N entries. Default 100.' },
        clear: { type: 'boolean', description: 'Empty the buffer after reading.' },
        browser: browserProp,
      },
      required: ['tabId'],
    },
  },
  {
    name: 'read_network_requests',
    description:
      'Read network requests captured since the tab joined this session, with status, type, and size. ' +
      'Filter with url_pattern or only_failed to find the request you care about.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProp,
        url_pattern: { type: 'string', description: 'Case-insensitive regular expression filter on the URL.' },
        only_failed: { type: 'boolean', description: 'Return only failed requests and 4xx/5xx responses.' },
        limit: { type: 'number', description: 'Most recent N requests. Default 100.' },
        clear: { type: 'boolean', description: 'Empty the buffer after reading.' },
        browser: browserProp,
      },
      required: ['tabId'],
    },
  },
  {
    name: 'page_state',
    description: 'Current URL, title, scroll position, viewport size, and load state. Cheap orientation check after an action.',
    inputSchema: {
      type: 'object',
      properties: { tabId: tabIdProp, browser: browserProp },
      required: ['tabId'],
    },
  },
  {
    name: 'wait_for_page',
    description:
      'Wait for loading to finish and the DOM to stop mutating. Use after an action that triggers navigation or a ' +
      'slow render, instead of a fixed sleep.',
    inputSchema: {
      type: 'object',
      properties: { tabId: tabIdProp, timeout: { type: 'number', description: 'Milliseconds, default 15000.' }, browser: browserProp },
      required: ['tabId'],
    },
  },
  {
    name: 'resize_window',
    description: 'Resize the window holding a tab. Use to test responsive layouts.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number' },
        height: { type: 'number' },
        tabId: tabIdProp,
        browser: browserProp,
      },
      required: ['width', 'height', 'tabId'],
    },
  },
  {
    name: 'file_upload',
    description:
      'Attach local files to a page. Point ref at an <input type=file> and its files are set directly. ' +
      'Point it at a drop zone with no file input and the files are dropped onto it, which is how most ' +
      'drag-and-drop upload areas work. Paths are on this machine and must be readable.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Ref of the file input or the drop target.' },
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description:
            '[x, y] to drop onto, from the last screenshot. Use this for a drop zone that is a plain div, ' +
            'since those carry no role or name and do not appear in the tree.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Absolute or relative paths to the files to attach.',
        },
        tabId: tabIdProp,
        browser: browserProp,
      },
      required: ['paths', 'tabId'],
    },
  },
  {
    name: 'gif_creator',
    description:
      'Record what happens in a tab as an animated GIF, to document or share a flow. ' +
      'Call it with "start", drive the page as usual, then "stop" to write the file and get its path. ' +
      'A frame is captured on every click, keystroke, scroll and navigation while a recording is open, ' +
      'so the result shows the steps rather than a fixed-rate video. Use "frame" to force one, ' +
      '"cancel" to throw the recording away. The recording captures whatever is on screen, including ' +
      'account details on a signed-in page, so review it before sharing it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'frame', 'stop', 'cancel', 'start_recording', 'stop_recording', 'export', 'clear'],
          description: 'start_recording, stop_recording, export and clear are accepted as the same four actions.',
        },
        filename: { type: 'string', description: 'For stop: name of the gif file. Default recording-<timestamp>.gif.' },
        tabId: tabIdProp,
        browser: browserProp,
      },
      required: ['action', 'tabId'],
    },
  },
  {
    name: 'quick',
    description:
      'Run a compact action script in ONE round trip. Use this for any sequence of three or more steps: ' +
      'it is the cheapest way to drive a page, because the whole sequence costs one model turn and one line ' +
      'per action instead of a nested JSON object per action.\n' +
      'One command per line. Targets are either a ref from read_page or an "x y" pair from a screenshot.\n' +
      '  C <target>      left click            RC/DC/TC <target>  right / double / triple click\n' +
      '  H <target>      hover                 SC ref_N           scroll into view\n' +
      '  T <text>        type text             TK <text>          type with real key events\n' +
      '  K <keys>        press keys            F ref_N <value>    set a form control\n' +
      '  S <dir> [n]     scroll                D x1 y1 x2 y2      drag\n' +
      '  N <url>         navigate              J <expression>     evaluate javascript\n' +
      '  W [ms]          wait for the page to settle              PAUSE [s]  sleep\n' +
      '  R [all]         read the page         X                  read page text\n' +
      '  SS              screenshot            P                  page state\n' +
      '  Z x0 y0 x1 y1   zoom to a region      # ...              comment\n' +
      '  NT [url]        new tab, later lines act on it            ST tabId   switch tab\n' +
      '  LT              list tabs\n' +
      'The whole script is parsed before anything runs, so a typo cannot leave the page half finished. ' +
      'Execution stops at the first failing line and reports which one.',
    inputSchema: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'Newline-separated commands, e.g. "F ref_12 hello\\nC ref_18\\nK Enter\\nW\\nR".',
        },
        tabId: tabIdProp,
        browser: browserProp,
      },
      required: ['script', 'tabId'],
    },
  },
  {
    name: 'list_connected_browsers',
    description:
      'List the browsers currently running the extension, with the id to pass to select_browser. ' +
      'Each row carries the label, profile directory and name, account email, version, whether it is on this ' +
      'machine, whether it is the development browser, and the sites that profile is signed into. ' +
      'Call this when a tool reports that several browsers are connected, or to check which one is in use.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'select_browser',
    description:
      'Choose which connected browser this session drives. Needed only when more than one is connected, ' +
      'since a single browser is used automatically. The choice holds for the rest of the session. ' +
      'Pass exactly one of the arguments below. Two browsers matching a site selector is an error ' +
      '(profile_ambiguous) listing both, rather than a guess.',
    inputSchema: {
      type: 'object',
      properties: {
        browserId: { type: 'string', description: 'Id or name from list_connected_browsers, e.g. "Edge".' },
        label: { type: 'string', description: 'The label set on the extension options page, e.g. "Work Chrome".' },
        profile: { type: 'string', description: 'Profile directory or display name, e.g. "Default" or "Profile 2" or "Work".' },
        account: { type: 'string', description: 'Signed-in account email, e.g. "me@example.com".' },
        site: {
          type: 'string',
          description:
            'Domain this profile is signed into, e.g. "linkedin.com". The development browser is never matched this way.',
        },
      },
    },
  },
  {
    name: 'switch_browser',
    description: 'Move this session to a different connected browser. Same as select_browser.',
    inputSchema: {
      type: 'object',
      properties: {
        browserId: { type: 'string', description: 'Id or name from list_connected_browsers.' },
        label: { type: 'string', description: 'The label set on the extension options page.' },
        profile: { type: 'string', description: 'Profile directory or display name.' },
        account: { type: 'string', description: 'Signed-in account email.' },
        site: { type: 'string', description: 'Domain this profile is signed into, e.g. "linkedin.com".' },
      },
    },
  },
  {
    name: 'shortcuts_list',
    description:
      'List the saved shortcuts for this browser. A shortcut is a named quick script, saved from the ' +
      "extension's options page, for a flow that gets repeated. Run one with shortcuts_execute.",
    inputSchema: { type: 'object', properties: { browser: browserProp } },
  },
  {
    name: 'shortcuts_execute',
    description:
      'Run a saved shortcut against a tab. The shortcut is a quick script, so it reports per-line results ' +
      'and stops at the first failing line, exactly like quick.',
    inputSchema: {
      type: 'object',
      properties: {
        shortcutId: { type: 'string', description: 'Id or name from shortcuts_list.' },
        tabId: tabIdProp,
        browser: browserProp,
      },
      required: ['shortcutId', 'tabId'],
    },
  },
  {
    name: 'upload_image',
    description:
      'Attach an image to the page. Give the imageId printed under a screenshot, a path to a local image, or ' +
      '"last" for the most recent screenshot. Target a file input by ref, or a drop zone by ref or coordinate.',
    inputSchema: {
      type: 'object',
      properties: {
        imageId: { type: 'string', description: 'Id of a screenshot taken in this session, e.g. "img_3".' },
        path: { type: 'string', description: 'Image file to attach, or "last" for the most recent screenshot.' },
        filename: { type: 'string', description: 'Name the page sees for the file. Default "image.png".' },
        ref: { type: 'string', description: 'Ref of the file input or drop target.' },
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: '[x, y] to drop onto, for a drop zone with no file input.',
        },
        tabId: tabIdProp,
        browser: browserProp,
      },
      required: ['tabId'],
    },
  },
  {
    name: 'browser_batch',
    description:
      'Run several browser calls in ONE round trip. Every tool call is a full model turn, so batching is the ' +
      'difference between a ten-step flow taking ten turns and taking one. Use it whenever you can predict two or ' +
      'more steps ahead, for example: click a field, type, press Enter, wait, read the page. ' +
      'Actions run in order and stop at the first error, so a failed step never leaves later steps acting on a page ' +
      'that is not in the state they assumed. Coordinates inside a batch refer to the screenshot taken before the ' +
      'batch, so prefer refs. browser_batch cannot be nested. Claude in Chrome spellings (tabs_create_mcp, ' +
      'javascript_tool, onlyErrors, urlPattern) are accepted. A tabs_create earlier in the batch can be referred to ' +
      'by later actions with tabId "$last".',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          minItems: 1,
          description: 'Sequence of {name, input} entries, where input is what you would pass that tool directly.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Tool name. browser_batch cannot be nested.' },
              input: { type: 'object', description: 'That tool\'s arguments.' },
            },
            required: ['name', 'input'],
          },
        },
        browser: browserProp,
      },
      required: ['actions'],
    },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);
