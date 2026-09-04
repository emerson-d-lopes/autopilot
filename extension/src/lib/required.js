// Arguments a tool cannot run without.
//
// browser_batch has always checked these before the first item ran, so a typo
// at item five could not cost the side effects of items one to four. A direct
// call had no equivalent: navigate without a url drove the tab to
// https://undefined and spent five seconds failing to resolve it. The same
// table now guards both, and the host checks its own copy from the schemas
// before the call ever reaches the browser.
//
// The list mirrors the `required` arrays in host/schemas.js. test/errors.test.js
// asserts the two agree, so a schema that grows a required argument cannot
// leave this behind.

/** @type {Record<string, string[]>} */
export const REQUIRED_ARGS = {
  tabs_close: ['tabId'],
  navigate: ['tabId', 'url'],
  read_page: ['tabId'],
  get_page_text: ['tabId'],
  find: ['tabId', 'query'],
  form_input: ['tabId', 'ref', 'value'],
  computer: ['tabId', 'action'],
  javascript: ['tabId', 'code'],
  read_console_messages: ['tabId'],
  read_network_requests: ['tabId'],
  page_state: ['tabId'],
  wait_for_page: ['tabId'],
  resize_window: ['tabId', 'width', 'height'],
  file_upload: ['tabId', 'paths'],
  gif_creator: ['tabId', 'action'],
  quick: ['tabId', 'script'],
  shortcuts_execute: ['tabId', 'shortcutId'],
  upload_image: ['tabId'],
  declare_plan: ['origins'],
  browser_batch: ['actions'],
};

/**
 * The arguments this call is missing, in the order the schema declares them.
 *
 * `false`, `0` and `""` are values a caller meant to send, so only undefined
 * and null count as missing.
 */
export function missingRequired(tool, input = {}) {
  const needed = REQUIRED_ARGS[tool];
  if (!needed) return [];
  const args = input && typeof input === 'object' ? input : {};
  return needed.filter((key) => args[key] === undefined || args[key] === null);
}

/** The sentence a refusal carries, naming what to add. */
export function missingRequiredMessage(tool, missing) {
  return (
    tool + ' needs ' + missing.join(' and ') + '. The call was refused before anything ran, so the tab was ' +
    'not touched.'
  );
}
