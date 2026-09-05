// Intercepts require('axios') everywhere in a test file's process so a bot's
// real HTTP calls (its features/scraper.js, registry sync, etc.) never happen
// -- every test controls exactly what the "API" returns via the handler
// passed to install(). Node's test runner gives each test *file* its own
// process by default, so patching Module.prototype.require here doesn't
// leak into other test files.
//
// handler(url, bodyOrConfig) -> { data } or throws (to simulate a network
// failure). The same handler backs both verbs: GET calls dispatch through
// the identical URL-pattern-matching style POST handlers already use, so no
// test needs a separate handler shape.
//
// Each bot keeps its own game-specific default handler (what its "/player"
// and "/gift_code" endpoints look like) next to its re-export of this file.
const Module = require('module');

const originalRequire = Module.prototype.require;

function install(handler) {
  const previousRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'axios') {
      return {
        post: async (url, body) => handler(url, body),
        get: async (url, config) => handler(url, config)
      };
    }
    return previousRequire.apply(this, arguments);
  };
}

function uninstall() {
  Module.prototype.require = originalRequire;
}

module.exports = { install, uninstall };
