const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGiftCodeDetector, labeledCodeRegex, bareLineRegex } = require('../features/giftcodeDetection');

// The exact regex literals each bot shipped with before extraction. The
// builders must reproduce them byte-for-byte -- that's what makes this a
// refactor and not a behavior change.
const BYTEME_LABELED = /\b(?:code|cdk)s?\s*:\s*(?!https?:\/\/)([A-Za-z0-9]{4,25})\b/gi;
const BYTEME_BARE = /^(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{4,25}$/;
const HERALD_LABELED = /\b(?:gift\s*code|code|cdk)s?\s*:\s*(?!https?:\/\/)`?([A-Za-z0-9]{4,25})`?/gi;
const HERALD_BARE_MIXED = /^(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{4,25}$/;
const HERALD_BARE_LETTERS = /^[A-Za-z]{10,25}$/;

const byteme = createGiftCodeDetector({
  labeledRegex: labeledCodeRegex({ labels: ['code', 'cdk'], allowBackticks: false, trailingBoundary: true }),
  bareLineRegexes: [bareLineRegex({ minLength: 4, maxLength: 25, requireLetter: true })]
});

const herald = createGiftCodeDetector({
  labeledRegex: labeledCodeRegex({ labels: ['gift\\s*code', 'code', 'cdk'], allowBackticks: true, trailingBoundary: false }),
  bareLineRegexes: [
    bareLineRegex({ minLength: 4, maxLength: 25, requireLetter: true, requireDigit: true }),
    bareLineRegex({ minLength: 10, maxLength: 25, lettersOnly: true })
  ]
});

// ─── builders reproduce the shipped literals exactly ────────────────────────

test('labeledCodeRegex reproduces ByteMe\'s and Herald\'s shipped regexes exactly (source and flags)', () => {
  assert.equal(byteme.labeledRegex.source, BYTEME_LABELED.source);
  assert.equal(byteme.labeledRegex.flags, BYTEME_LABELED.flags);
  assert.equal(herald.labeledRegex.source, HERALD_LABELED.source);
  assert.equal(herald.labeledRegex.flags, HERALD_LABELED.flags);
});

test('bareLineRegex reproduces both bots\' shipped bare-line regexes exactly', () => {
  assert.equal(byteme.bareLineRegexes[0].source, BYTEME_BARE.source);
  assert.equal(herald.bareLineRegexes[0].source, HERALD_BARE_MIXED.source);
  assert.equal(herald.bareLineRegexes[1].source, HERALD_BARE_LETTERS.source);
});

test('createGiftCodeDetector requires a global labeled regex (matchAll would throw otherwise)', () => {
  assert.throws(() => createGiftCodeDetector({ labeledRegex: /code:\s*(\w+)/i }), /g flag/);
  assert.throws(() => createGiftCodeDetector({ labeledRegex: 'code' }), /RegExp/);
});

// ─── ByteMe's corpus (its own giftcode.test.js cases, verbatim) ────────────

test('ByteMe: labeled code, no backticks', () => {
  assert.deepEqual(byteme.extractGiftCodes('Gift Code: OFFICIALSTORE0709'), ['OFFICIALSTORE0709']);
});

test('ByteMe: a backtick-wrapped labeled code is NOT detected (documented, verified-live behavior)', () => {
  assert.deepEqual(byteme.extractGiftCodes('Gift Code: `OFFICIALSTORE0709`'), []);
});

test('ByteMe: case-insensitive label, cdk variant', () => {
  assert.deepEqual(byteme.extractGiftCodes('code: wos888'), ['wos888']);
  assert.deepEqual(byteme.extractGiftCodes('cdk: ABC123XYZ'), ['ABC123XYZ']);
});

test('ByteMe: bare code on its own line; multiple bare codes deduplicated; labeled + bare mixed', () => {
  assert.deepEqual(byteme.extractGiftCodes('SarahJean says:\nWOSCODE2026\nthanks!'), ['WOSCODE2026']);
  assert.deepEqual(byteme.extractGiftCodes('CODE1ABC\nCODE2DEF\nCODE1ABC'), ['CODE1ABC', 'CODE2DEF']);
  assert.deepEqual(byteme.extractGiftCodes('Gift Code: LABELED123\nBARECODE456').sort(), ['BARECODE456', 'LABELED123']);
});

test('ByteMe: does NOT false-positive on a URL after "codes:"', () => {
  assert.deepEqual(byteme.extractGiftCodes('New codes: https://wossite.com/gift'), []);
});

test('ByteMe: a standalone pure-letter word IS a bare code (no digit required -- gogoWOS, EidMubarak)', () => {
  assert.deepEqual(byteme.extractGiftCodes('nicework'), ['nicework']);
  assert.deepEqual(byteme.extractGiftCodes('gogoWOS'), ['gogoWOS']);
});

test('ByteMe: multi-word prose and numeric-only lines are not codes; empty/null -> []', () => {
  assert.deepEqual(byteme.extractGiftCodes('hello there\nthanks so much\nnice work everyone'), []);
  assert.deepEqual(byteme.extractGiftCodes('123456'), []);
  assert.deepEqual(byteme.extractGiftCodes(''), []);
  assert.deepEqual(byteme.extractGiftCodes(null), []);
});

// ─── Herald's corpus (its own giftcode.test.js cases, verbatim) ────────────

test('Herald: labeled code with backticks, without, cdk variant', () => {
  assert.deepEqual(herald.extractGiftCodes('Gift Code: `OFFICIALSTORE0709`'), ['OFFICIALSTORE0709']);
  assert.deepEqual(herald.extractGiftCodes('code: kingshot888'), ['kingshot888']);
  assert.deepEqual(herald.extractGiftCodes('cdk: ABC123XYZ'), ['ABC123XYZ']);
});

test('Herald: bare code on its own line; deduplicated; labeled(backticked) + bare mixed', () => {
  assert.deepEqual(herald.extractGiftCodes('SarahJean says:\nKINGSHOT2026\nthanks!'), ['KINGSHOT2026']);
  assert.deepEqual(herald.extractGiftCodes('CODE1ABC\nCODE2DEF\nCODE1ABC'), ['CODE1ABC', 'CODE2DEF']);
  assert.deepEqual(herald.extractGiftCodes('Gift Code: `LABELED123`\nBARECODE456').sort(), ['BARECODE456', 'LABELED123']);
});

test('Herald: does NOT false-positive on a URL after "codes:"', () => {
  assert.deepEqual(herald.extractGiftCodes('Check All available codes: https://kingshotwiki.com/codes'), []);
});

test('Herald: short pure-letter prose words alone on a line are rejected; 10+ letter codes are not', () => {
  assert.deepEqual(herald.extractGiftCodes('hello\nthanks\nnicework\ncongrats\nawesome\nbeautiful'), []);
  assert.deepEqual(herald.extractGiftCodes('PROTECTNATURE'), ['PROTECTNATURE']);
});

test('Herald: every real KingShot code from a screenshotted list of past codes is detected', () => {
  const realCodes = [
    'PROTECTNATURE', 'KS0603', 'KSPRAWNING', 'BESTMOM2026', 'Childrenday0505',
    'LOVEFAMILY', 'OFFICIALSTORE516', 'CHILDFUN2026', 'EIDALADHA0527',
    'WORKERPOWER', 'KSGW26JP', 'OFFICIALSTORE9', 'KS0426', '0425FORU',
    'KINGSHOT13M', 'STORELAUNCH', 'TGIFISBACK', 'TOGOVERNOR', 'HELLOWORLD25',
    'KSDC400K', 'TGIF1107', 'HALLOWEEN25', 'TRICKORTREAT', 'TGIF1016',
    'BONAPPETIT', 'COFFEEPOWER', 'ITISFRIDAY', '1INAMILLION'
  ];
  assert.deepEqual(herald.extractGiftCodes(realCodes.join('\n')).sort(), [...realCodes].sort());
  assert.deepEqual(herald.extractGiftCodes(''), []);
  assert.deepEqual(herald.extractGiftCodes(null), []);
});

// ─── the two configs really do differ where the games differ ───────────────

test('the same short pure-letter line is a code for ByteMe (WOS has 4-7 letter codes) and not for Herald', () => {
  assert.deepEqual(byteme.extractGiftCodes('thanks'), ['thanks']);
  assert.deepEqual(herald.extractGiftCodes('thanks'), []);
});

test('isBareCode is exposed for callers that want the line test on its own', () => {
  assert.equal(herald.isBareCode('KS0603'), true);
  assert.equal(herald.isBareCode('nicework'), false);
  assert.equal(byteme.isBareCode('nicework'), true);
});
