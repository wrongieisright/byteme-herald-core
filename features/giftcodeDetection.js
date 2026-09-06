// Gift-code detection: finding codes in free-form channel text (a Telegram
// post, a Discord announcement, a moderator typing a code bare on its own
// line). Two independent patterns, both real-incident-driven in both bots:
//
//   Labeled  -- a "code:" / "cdk:" style prefix (case-insensitive, optional
//               plural s), with a negative lookahead rejecting a URL scheme
//               right after the label. A real bug in both bots: "...codes:
//               https://..." satisfies the label pattern via the plural and
//               captured "https" as a bogus code.
//   Bare line -- an ENTIRE line that is nothing but the code. Matching a
//               bare token anywhere inside prose would false-positive on
//               ordinary chat; a standalone line is a much stronger signal.
//
// The algorithm (every labeled match, then every bare line, first-appearance
// order, de-duplicated) is shared. The *shapes* are not: the two games' real
// codes differ enough that forcing one regex on both would regress one of
// them -- WOS codes are regularly pure letters as short as 4-7 chars
// ("gogoWOS", "EidMubarak"), while Kingshot's digit-free codes were all 10+
// chars and short bare words ("thanks", "awesome") must not match. So each
// bot builds its own regexes with the helpers below and injects them.
// The builders exist so a bot's config reads as intent ("allow backticks",
// "letters-only needs 10+") rather than as regex, and the core's tests pin
// the builders' output to the exact literals both bots shipped with.

const ALNUM = 'A-Za-z0-9';

// labels: alternatives for the label word, as regex source fragments (e.g.
//   'gift\\s*code'). allowBackticks: accept `CODE` (Kingshot's official
//   Discord format wraps the code in backticks). trailingBoundary: require a
//   word boundary after the code (ByteMe's original had it; Herald's didn't,
//   since a closing backtick is not a word character).
function labeledCodeRegex({
  labels = ['code', 'cdk'],
  allowBackticks = false,
  trailingBoundary = true,
  minLength = 4,
  maxLength = 25
} = {}) {
  const bt = allowBackticks ? '`?' : '';
  const tb = trailingBoundary ? '\\b' : '';
  return new RegExp(
    `\\b(?:${labels.join('|')})s?\\s*:\\s*(?!https?:\\/\\/)${bt}([${ALNUM}]{${minLength},${maxLength}})${bt}${tb}`,
    'gi'
  );
}

// A whole-line matcher. lettersOnly: the line must be letters and nothing
// else; otherwise alphanumeric, with requireLetter/requireDigit as
// lookaheads (a bare number alone on a line -- a date, a member count --
// must never be mistaken for a code, so requireLetter defaults on).
function bareLineRegex({
  minLength = 4,
  maxLength = 25,
  requireLetter = true,
  requireDigit = false,
  lettersOnly = false
} = {}) {
  if (lettersOnly) return new RegExp(`^[A-Za-z]{${minLength},${maxLength}}$`);
  const letter = requireLetter ? `(?=[${ALNUM}]*[A-Za-z])` : '';
  const digit = requireDigit ? `(?=[${ALNUM}]*[0-9])` : '';
  return new RegExp(`^${letter}${digit}[${ALNUM}]{${minLength},${maxLength}}$`);
}

// labeledRegex: a global+case-insensitive RegExp whose first capture group is
//   the code (from labeledCodeRegex, or the bot's own literal).
// bareLineRegexes: one or more whole-line RegExps; a trimmed line counts as a
//   bare code if any of them matches.
function createGiftCodeDetector({ labeledRegex, bareLineRegexes = [] }) {
  if (!(labeledRegex instanceof RegExp) || !labeledRegex.global) {
    throw new Error('createGiftCodeDetector: labeledRegex must be a RegExp with the g flag');
  }
  const bare = Array.isArray(bareLineRegexes) ? bareLineRegexes : [bareLineRegexes];

  function isBareCode(line) {
    return bare.some(re => re.test(line));
  }

  // Returns every gift code found in a message's text, not just the first --
  // a message can contain multiple labeled codes, multiple bare codes (one
  // per line), or a mix of both. Order of first appearance, de-duplicated.
  function extractGiftCodes(text) {
    if (!text) return [];

    const codes = new Set();

    for (const m of text.matchAll(labeledRegex)) {
      codes.add(m[1]);
    }

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (isBareCode(trimmed)) codes.add(trimmed);
    }

    return [...codes];
  }

  return { extractGiftCodes, isBareCode, labeledRegex, bareLineRegexes: bare };
}

module.exports = { createGiftCodeDetector, labeledCodeRegex, bareLineRegex };
