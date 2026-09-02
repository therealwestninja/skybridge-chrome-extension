/* chloe-nation - the Seven Nations: the top, human-readable brain layer.
 *
 * Seven small faculties of mind each weigh in on what to say. Their votes are tallied by the weights you set,
 * using the same Brain sub-system underneath (ChloeBrain.resolve), and the winning reply is spoken. Seven, so a
 * vote can never tie. This layer is deliberately simple and readable - it sits ABOVE the compiled brain.min.js,
 * while the memory and personality underneath stay with the mouth.
 *
 * It knows what it is and never refuses to say so: ask it and it volunteers (see `about`).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node / harness
  root.ChloeNation = api;                                                    // window / app
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The seven nations. Each has a plain-English purpose and a "lean" - what it values in a reply.
  // lean features:  warm (sounds caring) - clear (a readable, sane length) - open (ends on a real question)
  //                 play (a little voice / action) - calm (not over-long, not frantic)
  // The seven seed faculties. Routing/scale metadata (DESIGN-routing-layer.md): `core` = non-routable floor;
  // `domain` = experiential domain (the registry index key); `relevance(vibe)` = pure [0,1], CENTERED AT 0.5 on a
  // neutral vibe so weighting is parity-safe. `kind` defaults to 'deliberator' (these seven all vote).
  var NATIONS = [
    { id: 'heart',      purpose: 'Make sure she sounds like she cares.',            lean: { warm: 1.0, clear: 0.3 },
      core: true,  domain: ['support'],
      relevance: function (v) { return clamp01(0.5 + v.vulnerability * 0.4 + v.warmth * 0.2); },
      nominate: function (vibe, ctx) {                        // heart calls in the felt (inner) sense when the talk turns to an inner state
        var t = ' ' + String(ctx && (ctx.prompt || ctx.text) || '').toLowerCase() + ' ';
        var hit = /\b(shallow|deep|depth|narrow|wide|thin|thick|empty|full|stop|awake|alert|sleepy|tired|exhausted|drained|pinched|stretched|pushed|pulled)\b/.test(t) || /keep going|keep on|press on|push on|carry on/.test(t);
        return hit ? ['felt'] : [];
      } },
    { id: 'reason',     purpose: 'Keep it clear, honest, and easy to follow.',      lean: { clear: 1.0, calm: 0.4 },
      domain: ['support', 'meta'],
      relevance: function (v) { return clamp01(0.5 + v.openness * 0.4 + v.tension * 0.1); },
      nominate: function (vibe, ctx) {                        // reason calls in calc when the line asks for a number
        var t = String(ctx && (ctx.prompt || ctx.text) || '').toLowerCase();
        var hit = /\d\s*[-+*\/x^%]\s*[-(\d]/.test(t) || /\d+(?:\.\d+)?\s*%\s*of/.test(t)
          || /\b(calculate|compute|convert|how much is|how many)\b/.test(t)
          || /\d+(?:\.\d+)?\s*(?:mm|cm|km|m|meters?|metres?|in|inch(?:es)?|ft|foot|feet|yd|yards?|mi|miles?|c|f|k|celsius|fahrenheit|kelvin)\b\s*(?:into|in|to|as)\b/.test(t);
        return hit ? ['calc'] : [];
      } },
    { id: 'memory',     purpose: 'Keep her consistent with what she knows of you.', lean: { warm: 0.5, clear: 0.5 },
      domain: ['lore'],
      relevance: function (v) { return clamp01(0.5 + v.engagement * 0.2 - v.tension * 0.1); } },
    { id: 'instinct',   purpose: 'Flag anything that feels off, unsafe, or false.', lean: { calm: 1.0, clear: 0.3 },
      core: true,  domain: ['support'],
      relevance: function (v) { return clamp01(0.5 + v.tension * 0.5 + v.vulnerability * 0.2); } },
    { id: 'voice',      purpose: 'Keep her voice distinct and natural.',            lean: { play: 1.0, warm: 0.3 },
      domain: ['roleplay', 'banter'],
      relevance: function (v) { return clamp01(0.5 + v.warmth * 0.2 + v.openness * 0.1 - v.vulnerability * 0.2); } },
    { id: 'conscience', purpose: 'Protect your wellbeing, above all.',              lean: { warm: 0.7, calm: 0.6 },
      core: true,  domain: ['support'],
      relevance: function (v) { return clamp01(0.5 + v.vulnerability * 0.5 + v.tension * 0.2); } },
    { id: 'play',       purpose: 'Keep it alive, curious, and human.',              lean: { open: 1.0, play: 0.5 },
      domain: ['banter', 'roleplay'],
      relevance: function (v) { return clamp01(0.5 + (v.warmth + v.openness) * 0.4 - (v.vulnerability + v.tension) * 0.6); } }
  ];

  // ---- almanac: a BUNDLED, static, offline reference set (DESIGN-specialists: a self-contained contributor). Unlike
  // `lore` (an app-backed contributor whose material the app injects from real memory), `almanac` ships its own small
  // book and works standalone. It proves the SCALE / Dewey pattern: a faculty per subject that pipes up with a fitting
  // fact when its subject comes up, supplies that material to the turn, and never votes. An app may extend ALMANAC.
  var ALMANAC = [
    { s: 'astronomy', k: ['moon'],            a: 'The Moon is on average about 384,400 km from Earth.' },
    { s: 'astronomy', k: ['sun'],             a: 'The Sun is about 150 million km from Earth, a distance called one astronomical unit.' },
    { s: 'astronomy', k: ['mars'],            a: 'Mars is the fourth planet from the Sun and is often called the Red Planet.' },
    { s: 'astronomy', k: ['jupiter'],         a: 'Jupiter is the largest planet in the Solar System.' },
    { s: 'astronomy', k: ['galaxy', 'milky'], a: 'Our Solar System lies in the Milky Way galaxy.' },
    { s: 'physics',   k: ['gravity'],         a: 'On Earth, gravity accelerates a falling object at about 9.8 metres per second squared.' },
    { s: 'physics',   k: ['sound'],           a: 'Sound travels about 343 metres per second through air at room temperature.' },
    { s: 'physics',   k: ['photon', 'lightspeed'], a: 'Light travels about 299,792 kilometres per second in a vacuum.' },
    { s: 'geography', k: ['everest'],         a: 'Mount Everest is the highest mountain above sea level, about 8,849 metres.' },
    { s: 'geography', k: ['nile'],            a: 'The Nile is one of the longest rivers in the world, about 6,650 km.' },
    { s: 'geography', k: ['amazon'],          a: 'The Amazon carries more water than any other river on Earth.' },
    { s: 'geography', k: ['sahara'],          a: 'The Sahara is the largest hot desert in the world.' },
    { s: 'geography', k: ['pacific'],         a: 'The Pacific is the largest and deepest ocean on Earth.' },
    { s: 'biology',   k: ['human heart', 'heart rate', 'heartbeat', 'resting heart', 'pulse rate'], a: 'A resting adult human heart beats roughly 60 to 100 times per minute.' },   // was the bare 'heart' - too greedy ("my heart", "what is my heart rate", "heart to heart")
    { s: 'biology',   k: ['brain', 'neurons'],a: 'The adult human brain contains roughly 86 billion neurons.' },
    { s: 'biology',   k: ['photosynthesis'],  a: 'Photosynthesis is how plants turn sunlight, water, and carbon dioxide into energy and oxygen.' },
    { s: 'biology',   k: ['dna'],             a: 'DNA carries genetic information in a double-helix structure.' },
    { s: 'chemistry', k: ['gold'],            a: 'The chemical symbol for gold is Au, from the Latin aurum.' },
    { s: 'chemistry', k: ['oxygen'],          a: 'Oxygen makes up about 21 percent of the atmosphere.' },
    { s: 'chemistry', k: ['water'],           a: 'A water molecule is two hydrogen atoms bonded to one oxygen atom, written H2O.' },
    { s: 'history',   k: ['rome', 'roman'],   a: 'The Western Roman Empire is generally dated as falling in 476 CE.' },
    { s: 'history',   k: ['egypt', 'pyramids'], a: 'The Great Pyramid of Giza was built around 2,560 BCE.' },
    { s: 'mathematics', k: ['pi', 'circumference'], a: 'Pi is approximately 3.14159, relating the circumference of a circle to its diameter.' },
    { s: 'units',     k: ['mile', 'miles'],   a: 'One mile is about 1.609 kilometres.' },
    { s: 'language',  k: ['palindrome'],      a: 'A palindrome reads the same forwards and backwards, like the word level.' },
    // world capitals (Dewey-scale: one entry per subject, keyed on the country)
    { s: 'capitals', k: ['france'],                 a: 'Paris is the capital of France.' },
    { s: 'capitals', k: ['england', 'britain', 'kingdom'], a: 'London is the capital of the United Kingdom.' },
    { s: 'capitals', k: ['germany'],                a: 'Berlin is the capital of Germany.' },
    { s: 'capitals', k: ['spain'],                  a: 'Madrid is the capital of Spain.' },
    { s: 'capitals', k: ['italy'],                  a: 'Rome is the capital of Italy.' },
    { s: 'capitals', k: ['portugal'],               a: 'Lisbon is the capital of Portugal.' },
    { s: 'capitals', k: ['netherlands', 'holland'], a: 'Amsterdam is the capital of the Netherlands.' },
    { s: 'capitals', k: ['greece'],                 a: 'Athens is the capital of Greece.' },
    { s: 'capitals', k: ['ireland'],                a: 'Dublin is the capital of Ireland.' },
    { s: 'capitals', k: ['russia'],                 a: 'Moscow is the capital of Russia.' },
    { s: 'capitals', k: ['china'],                  a: 'Beijing is the capital of China.' },
    { s: 'capitals', k: ['japan'],                  a: 'Tokyo is the capital of Japan.' },
    { s: 'capitals', k: ['india'],                  a: 'New Delhi is the capital of India.' },
    { s: 'capitals', k: ['australia'],              a: 'Canberra is the capital of Australia.' },
    { s: 'capitals', k: ['canada'],                 a: 'Ottawa is the capital of Canada.' },
    { s: 'capitals', k: ['brazil'],                 a: 'Brasilia is the capital of Brazil.' },
    { s: 'capitals', k: ['mexico'],                 a: 'Mexico City is the capital of Mexico.' },
    { s: 'capitals', k: ['egypt'],                  a: 'Cairo is the capital of Egypt.' },
    { s: 'capitals', k: ['norway'],                 a: 'Oslo is the capital of Norway.' },
    { s: 'capitals', k: ['sweden'],                 a: 'Stockholm is the capital of Sweden.' },
    { s: 'capitals', k: ['poland'],                 a: 'Warsaw is the capital of Poland.' },
    { s: 'capitals', k: ['usa', 'america', 'states'], a: 'Washington, D.C. is the capital of the United States.' },
    { s: 'capitals', k: ['korea'],                  a: 'Seoul is the capital of South Korea.' },
    // a few more common facts
    { s: 'geography', k: ['continents'],   a: 'There are seven continents: Africa, Antarctica, Asia, Europe, North America, Oceania, and South America.' },
    { s: 'astronomy', k: ['earth'],        a: 'Earth is the third planet from the Sun.' },
    { s: 'astronomy', k: ['venus'],        a: 'Venus is the second planet from the Sun and the hottest in the Solar System.' },
    { s: 'chemistry', k: ['boiling', 'boil'],  a: 'Water boils at 100 degrees Celsius at sea level.' },
    { s: 'chemistry', k: ['freezing', 'freeze'], a: 'Water freezes at 0 degrees Celsius.' },
    { s: 'chemistry', k: ['elements', 'periodic'], a: 'The periodic table organizes the chemical elements by atomic number.' },
    // cities (so a trip/plan can call real place facts)
    { s: 'cities', k: ['vancouver'], a: 'Vancouver is a coastal city in British Columbia on Canada\'s west coast, framed by mountains and ocean.' },
    { s: 'cities', k: ['calgary'],   a: 'Calgary is a city in Alberta, Canada, near the Rocky Mountains, known for the Calgary Stampede.' },
    { s: 'cities', k: ['toronto'],   a: 'Toronto is the largest city in Canada, the capital of Ontario, on Lake Ontario.' },
    { s: 'cities', k: ['montreal'],  a: 'Montreal is the largest city in Quebec, Canada, known for its French-Canadian culture.' },
    { s: 'cities', k: ['edmonton'],  a: 'Edmonton is the capital of Alberta, Canada.' },
    { s: 'cities', k: ['banff'],     a: 'Banff is a resort town in the Canadian Rockies of Alberta, inside Banff National Park.' },
    { s: 'cities', k: ['seattle'],   a: 'Seattle is a major city in Washington State, USA, on the Pacific coast.' }
  ];
  // pure: scan the user text for a subject the book knows; return the single best-matching entry (most keyword hits,
  // ties broken by book order) or null. Word-boundary match after stripping punctuation. Deterministic, offline.
  function almanacLookup(text) {
    var t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
    if (t.length < 4) return null;
    if (isPersonalAsk(t)) return null;   // "what is MY heart rate" is about them, now - not a book subject (no canned line, no instant answer)
    var best = null, bestScore = 0, bestOn = '';
    for (var i = 0; i < ALMANAC.length; i++) {
      var e = ALMANAC[i], score = 0, on = '';
      for (var j = 0; j < e.k.length; j++) { if (t.indexOf(' ' + e.k[j] + ' ') >= 0) { score++; if (!on) on = e.k[j]; } }
      if (score > bestScore) { bestScore = score; best = e; bestOn = on; }
    }
    return best ? { subject: best.s, fact: best.a, on: bestOn } : null;
  }
  // ROUTES - relative distances between known places (so a trip plan can CALL a distance + drive time). Dewey-scale: add pairs.
  var ROUTES = [
    { a: 'vancouver', b: 'calgary',  km: 970, hours: 10,  via: 'the Coquihalla and the Rocky Mountains', stops: 'Kamloops, Banff, and Lake Louise' },
    { a: 'calgary',   b: 'edmonton', km: 300, hours: 3,   via: 'the QEII Highway', stops: 'Red Deer' },
    { a: 'calgary',   b: 'banff',    km: 130, hours: 1.5, via: 'the Trans-Canada Highway', stops: 'Canmore' },
    { a: 'toronto',   b: 'montreal', km: 540, hours: 5.5, via: 'Highway 401', stops: 'Kingston and the Thousand Islands' },
    { a: 'vancouver', b: 'seattle',  km: 230, hours: 2.5, via: 'I-5 and the border crossing at Blaine' }
  ];
  function routeOf(a, b) {
    var x = String(a || '').toLowerCase().trim(), y = String(b || '').toLowerCase().trim();
    for (var i = 0; i < ROUTES.length; i++) { var r = ROUTES[i]; if ((r.a === x && r.b === y) || (r.a === y && r.b === x)) return r; }
    return null;
  }
  function relDrive(hours) {   // relative-distance language, not a bare number
    if (!(hours > 0)) return '';
    if (hours < 1.5) return 'a quick hop, under an hour or two';
    if (hours < 3)   return 'a couple of hours by car';
    if (hours < 5)   return 'a half-day drive';
    if (hours < 8)   return 'the better part of a day on the road';
    if (hours < 13)  return 'a long full day of driving';
    return 'a multi-day haul';
  }

  // ---- touch: a self-contained tactile SENSE (a contributor, like almanac). Given a material + a state
  // (wet/dry/hot/cold/frozen...), it REASONS to a feel: "wet paper towel" -> slimy, "dry paper towel" -> rough.
  // Co-refs biology: skin is the sensing surface; flesh/hair are materials too, so it pulls into a physical scene. ----
  var TOUCH_DIMS = {
    texture:     ['smooth', 'rough', 'gritty', 'silky', 'fuzzy', 'papery', 'slimy', 'sticky', 'slick', 'soggy', 'limp'],
    temperature: ['freezing', 'cold', 'cool', 'lukewarm', 'warm', 'hot', 'scalding'],
    wetness:     ['dry', 'damp', 'moist', 'wet', 'soaked', 'humid'],
    viscosity:   ['thin', 'runny', 'watery', 'thick', 'gloopy', 'slimy', 'sticky'],
    hardness:    ['hard', 'firm', 'springy', 'soft', 'squishy', 'mushy']
  };
  // base feel + tags the transforms key on (absorbent / fibrous / hard / smooth / porous / granular / soft / conductive / living)
  var MATERIALS = {
    'paper towel': { texture: 'rough',  hardness: 'soft',  tags: ['absorbent', 'fibrous', 'porous'] },
    'paper':       { texture: 'smooth', hardness: 'firm',  tags: ['fibrous'] },
    'cloth':       { texture: 'fuzzy',  hardness: 'soft',  tags: ['absorbent', 'fibrous', 'soft'] },
    'cotton':      { texture: 'fuzzy',  hardness: 'soft',  tags: ['absorbent', 'fibrous', 'soft'] },
    'sponge':      { texture: 'fuzzy',  hardness: 'springy', tags: ['absorbent', 'porous', 'soft'] },
    'metal':       { texture: 'smooth', temperature: 'cool', hardness: 'hard', tags: ['hard', 'smooth', 'conductive'] },
    'steel':       { texture: 'smooth', temperature: 'cool', hardness: 'hard', tags: ['hard', 'smooth', 'conductive'] },
    'glass':       { texture: 'smooth', temperature: 'cool', hardness: 'hard', tags: ['hard', 'smooth'] },
    'stone':       { texture: 'rough',  temperature: 'cool', hardness: 'hard', tags: ['hard'] },
    'wood':        { texture: 'smooth', hardness: 'hard',  tags: [] },
    'sand':        { texture: 'gritty', hardness: 'soft',  tags: ['granular'] },
    'silk':        { texture: 'silky',  hardness: 'soft',  tags: ['smooth', 'soft'] },
    'rubber':      { texture: 'smooth', hardness: 'springy', tags: ['soft', 'grippy'] },
    'mud':         { texture: 'slimy',  hardness: 'soft',  wetness: 'wet', tags: ['granular', 'soft'] },
    'ice':         { texture: 'smooth', temperature: 'freezing', hardness: 'hard', tags: ['hard', 'smooth'] },
    'water':       { texture: 'smooth', temperature: 'cool', wetness: 'wet', viscosity: 'thin', tags: ['liquid'] },
    'oil':         { texture: 'slick',  viscosity: 'thick', tags: ['liquid', 'slick'] },
    'skin':        { texture: 'smooth', temperature: 'warm', hardness: 'soft', tags: ['soft', 'living'] },
    'flesh':       { texture: 'soft',   temperature: 'warm', hardness: 'soft', tags: ['soft', 'living'] },
    'hair':        { texture: 'silky',  hardness: 'soft',  tags: ['fibrous', 'soft', 'living'] }
  };
  var STATE_WORDS = ['soaked', 'wet', 'damp', 'moist', 'dry', 'frozen', 'hot', 'warm', 'cold'];
  function hasTag(p, tag) { return (p.tags || []).indexOf(tag) >= 0; }
  // reshape a material's feel by a state, keyed on its tags (this is the actual reasoning)
  function applyState(p, st) {
    if (st === 'wet' || st === 'soaked') {
      p.wetness = (st === 'soaked') ? 'soaked' : 'wet';
      if (hasTag(p, 'absorbent')) { p.texture = 'slimy'; p.hardness = 'mushy'; }        // soaks it up -> slimy/soggy
      else if (hasTag(p, 'fibrous')) p.texture = 'slimy';
      else if (hasTag(p, 'hard') || hasTag(p, 'smooth')) p.texture = 'slick';            // beads on hard surfaces -> slick
      else p.texture = 'slippery';
    } else if (st === 'damp' || st === 'moist') {
      p.wetness = st;
      if (hasTag(p, 'absorbent') || hasTag(p, 'fibrous')) p.texture = 'limp';
    } else if (st === 'dry') {
      p.wetness = 'dry';
      if ((hasTag(p, 'absorbent') || hasTag(p, 'fibrous')) && !p.texture) p.texture = 'rough';
    } else if (st === 'hot') { p.temperature = hasTag(p, 'conductive') ? 'scalding' : 'hot';
    } else if (st === 'warm') { p.temperature = 'warm';
    } else if (st === 'cold') { p.temperature = hasTag(p, 'conductive') ? 'freezing' : 'cold';
    } else if (st === 'frozen') { p.temperature = 'freezing'; p.hardness = 'hard'; p.texture = 'hard'; p.wetness = 'dry'; }
    return p;
  }
  // the feel of a (known) material under zero or more states; null for an unknown material
  function feelOf(material, states) {
    var base = MATERIALS[String(material || '').toLowerCase()];
    if (!base) return null;
    var p = { texture: base.texture, temperature: base.temperature, wetness: base.wetness, viscosity: base.viscosity, hardness: base.hardness, tags: (base.tags || []).slice() };
    (states || []).forEach(function (st) { applyState(p, st); });
    return p;
  }
  function feelPhrase(p) {
    if (!p) return '';
    var seen = {}, out = [];
    [p.temperature, p.wetness, p.texture, p.viscosity, p.hardness].forEach(function (b) { if ((b && b !== 'dry') || (b === 'dry' && !p.texture)) { if (b && !seen[b]) { seen[b] = 1; out.push(b); } } });
    return out.join(', ');
  }
  // scan a line for "<state>... <material>" and report how it would feel (the contributor's material; null if nothing tactile)
  function touchLookup(text) {
    var t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
    if (t.length < 4) return null;
    var mat = null;
    for (var name in MATERIALS) { if (t.indexOf(' ' + name + ' ') >= 0) { mat = name; break; } }
    if (!mat) return null;
    var states = STATE_WORDS.filter(function (w) { return t.indexOf(' ' + w + ' ') >= 0; });
    var p = feelOf(mat, states); if (!p) return null;
    var feel = feelPhrase(p);
    return { material: mat, states: states, feel: feel, note: (states.length ? states.join(' ') + ' ' : '') + mat + ' feels ' + feel + ' to the touch' };
  }

  // ---- the other senses, as a CLUSTER OF ADVISORS under the `scene` Nation (DESIGN-advisors: worked backwards from a
  // Nation). Each is a NARROW, single-domain contributor (sight / sound / smell / taste) that scene pulls in ONLY when
  // the scene cues that sense, so they are never all called at once. Each self-gates: no known thing named -> nothing.
  // Their relevance is kept under the 0.5 self-seat line on purpose, so they fire by nomination, not on their own. ----
  var SMELLS = {
    rain: 'earthy and clean, like petrichor', smoke: 'acrid and sharp', coffee: 'dark and roasted', bread: 'warm and yeasty',
    grass: 'green and just-cut', flowers: 'soft and floral', rose: 'sweet and heavy', sea: 'briny and salt-sharp',
    rot: 'putrid and sour', blood: 'hot and coppery', perfume: 'heady and sweet', pine: 'sharp and resinous',
    sweat: 'sour and warm', cooking: 'rich and savory', leather: 'dry and smoky', soap: 'clean and faintly floral'
  };
  var TASTES = {
    lemon: 'sharp and sour', salt: 'briny and clean', sugar: 'plain and sweet', honey: 'floral and slow-sweet',
    coffee: 'dark and bitter', chocolate: 'rich and bittersweet', blood: 'metallic and coppery', wine: 'dry and tannic',
    apple: 'crisp and tart', chili: 'fierce and burning', mint: 'cold and bright', tea: 'grassy and faintly bitter', smoke: 'ashen and dry'
  };
  var SOUNDS = {
    rain: 'a soft steady patter', thunder: 'a deep rolling rumble', wind: 'a low howl', fire: 'a faint crackle',
    footsteps: 'a measured tread', glass: 'a bright shatter', door: 'a slow creak', water: 'a running trickle',
    bell: 'a clear ring', clock: 'a steady tick', engine: 'a low growl', whisper: 'a dry hush', crowd: 'a dull roar', bird: 'a high trill'
  };
  var SIGHTS = {     // sight's specialty is LIGHT and how the scene reads; materials/texture belong to touch, not here
    dark: 'almost gone, all shadow and vague outline', dim: 'low and soft, the edges going grey', bright: 'sharp and vivid, every edge clear',
    candlelight: 'a warm wavering flicker', candlelit: 'a warm wavering flicker', moonlight: 'a pale silver wash', sunlight: 'clear and golden',
    firelight: 'a restless orange glow', neon: 'a hard electric wash', fog: 'a soft white blur', dusk: 'a dimming amber', dawn: 'a thin grey-gold'
  };
  // shared scanner: find a known thing for this sense and report its quality via the sense's own phrasing (the material)
  function senseLookup(text, lex, sense, noteFn) {
    var t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
    if (t.length < 4) return null;
    for (var k in lex) { if (lex[k] && t.indexOf(' ' + k + ' ') >= 0) { return { sense: sense, on: k, descriptor: lex[k], note: noteFn(k, lex[k]) }; } }
    return null;
  }
  function smellLookup(text) { return senseLookup(text, SMELLS, 'smell', function (k, d) { return 'the ' + k + ' smells ' + d; }); }
  function tasteLookup(text) { return senseLookup(text, TASTES, 'taste', function (k, d) { return 'the ' + k + ' tastes ' + d; }); }
  function soundLookup(text) { return senseLookup(text, SOUNDS, 'sound', function (k, d) { return 'you hear ' + d; }); }
  function sightLookup(text) { return senseLookup(text, SIGHTS, 'sight', function (k, d) { return 'the light is ' + d; }); }

  // ---- felt: the INNER sense (interoception), sibling to the five outward senses but turned inward. It reads the felt
  // quality of a thought or feeling along eight bipolar dimensions and grounds it in body-language. Parented to `heart`
  // (the emotional core), which calls it in ONLY when felt-language appears. Single domain, self-gating, nomination-driven. ----
  var FELT_DIMS = {
    depth:    ['shallow', 'deep'],
    breadth:  ['narrow', 'wide'],
    density:  ['thin', 'thick'],
    fullness: ['empty', 'full'],
    drive:    ['stop', 'going'],          // stop <-> keep going
    arousal:  ['tired', 'sleepy', 'awake'],
    strain:   ['pinched', 'stretched'],
    force:    ['pushed', 'pulled']
  };
  var FELT = {
    shallow:   { dim: 'depth',    pole: 'shallow',   note: 'skating the surface, not letting it land' },
    deep:      { dim: 'depth',    pole: 'deep',      note: 'down deep, far under the surface' },
    depth:     { dim: 'depth',    pole: 'deep',      note: 'down deep, far under the surface' },
    narrow:    { dim: 'breadth',  pole: 'narrow',    note: 'narrowed to a single point, everything else shut out' },
    wide:      { dim: 'breadth',  pole: 'wide',      note: 'wide open, room on every side' },
    thin:      { dim: 'density',  pole: 'thin',      note: 'worn thin, spread too far to cover it all' },
    thick:     { dim: 'density',  pole: 'thick',     note: 'thick and slow, hard to push a thought through' },
    empty:     { dim: 'fullness', pole: 'empty',     note: 'running on empty, hollowed out' },
    full:      { dim: 'fullness', pole: 'full',      note: 'full to the brim, no room left to take more in' },
    stop:      { dim: 'drive',    pole: 'stop',      note: 'everything in it leaning toward stop, toward setting it down' },
    awake:     { dim: 'arousal',  pole: 'awake',     note: 'lit up and wide awake, switched all the way on' },
    alert:     { dim: 'arousal',  pole: 'awake',     note: 'lit up and alert, every wire live' },
    sleepy:    { dim: 'arousal',  pole: 'sleepy',    note: 'heavy-lidded and slowing, starting to drift' },
    tired:     { dim: 'arousal',  pole: 'tired',     note: 'worn down, the charge gone low' },
    exhausted: { dim: 'arousal',  pole: 'tired',     note: 'wrung out, nothing left in the tank' },
    drained:   { dim: 'arousal',  pole: 'tired',     note: 'drained flat, the well gone dry' },
    pinched:   { dim: 'strain',   pole: 'pinched',   note: 'pinched tight, hemmed in with no give' },
    stretched: { dim: 'strain',   pole: 'stretched', note: 'stretched past the limit, ready to give' },
    pushed:    { dim: 'force',    pole: 'pushed',    note: 'pushed, a pressure at the back driving it on' },
    pulled:    { dim: 'force',    pole: 'pulled',    note: 'pulled, drawn toward something off ahead' }
  };
  // multi-word cues a single word can't catch (the "keep going" pole of drive)
  var FELT_PHRASES = [
    { re: /keep going|keep on|press on|push on|carry on/, dim: 'drive', pole: 'going', note: 'the pull to keep going, momentum carrying it forward' }
  ];
  // scan a line for felt-language; report the inner state along the dimensions it touches (one note per dimension, up to two)
  function feltLookup(text) {
    var t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
    if (t.length < 4) return null;
    var hits = [], seenDim = {};
    for (var i = 0; i < FELT_PHRASES.length; i++) { var ph = FELT_PHRASES[i]; if (ph.re.test(t) && !seenDim[ph.dim]) { seenDim[ph.dim] = 1; hits.push(ph); } }
    for (var w in FELT) { if (t.indexOf(' ' + w + ' ') >= 0) { var e = FELT[w]; if (!seenDim[e.dim]) { seenDim[e.dim] = 1; hits.push(e); } } }
    if (!hits.length) return null;
    return { sense: 'felt', dims: hits.map(function (h) { return h.dim + ':' + h.pole; }), note: hits.slice(0, 2).map(function (h) { return h.note; }).join('; ') };
  }

  // ---- calc: the first analytical advisor under `reason`. It recognises a simple text request for a number \u-
  // arithmetic, a percentage, or a unit conversion (length/distance/depth + temperature) \u- works it out ITSELF
  // (a small safe parser, never eval), and hands back a value + a formula + the words, so the council can read the
  // number and use it for something else. Single domain, self-gating, nomination-driven. ----
  var DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  var ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  var TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  function below1000(n) {
    var w = '';
    if (n >= 100) { w += ONES[Math.floor(n / 100)] + ' hundred'; n %= 100; if (n) w += ' '; }
    if (n >= 20) { w += TENS[Math.floor(n / 10)]; n %= 10; if (n) w += '-' + ONES[n]; }
    else if (n > 0) { w += ONES[n]; }
    return w;
  }
  function intToWords(n) {
    if (n === 0) return 'zero';
    var scales = ['', 'thousand', 'million', 'billion', 'trillion'], parts = [], i = 0;
    while (n > 0) { var chunk = n % 1000; if (chunk) parts.unshift(below1000(chunk) + (scales[i] ? ' ' + scales[i] : '')); n = Math.floor(n / 1000); i++; }
    return parts.join(' ');
  }
  function numToWords(x) {                                    // a number in words when it is clean enough to read
    if (x == null || !isFinite(x)) return null;
    if (x < 0) { var w = numToWords(-x); return w == null ? null : 'negative ' + w; }
    if (Math.round(x) === x) { return Math.abs(x) <= 999999999999 ? intToWords(x) : null; }
    var sx = String(x), dot = sx.indexOf('.'); if (dot < 0) return null;
    var iw = intToWords(parseInt(sx.slice(0, dot), 10)); if (iw == null) return null;
    return iw + ' point ' + sx.slice(dot + 1).split('').map(function (d) { return DIGITS[+d]; }).join(' ');
  }
  // RECURRENCE - lateral bond-settling (ported from Memory Hero): before the council votes, each faculty's proposal
  //   strength is nudged along its Hebbian bonds for a CAPPED 2 iterations - positive bond + co-activation excites,
  //   negative inhibits (graded lateral inhibition). Pure; runs only when cfg.settle. Fills the flagged "no within-turn recurrence" gap.
  function settleProposals(proposals, live) {
    try {
      if (!proposals || proposals.length < 2 || !live) return;
      var bondOf = {}; live.forEach(function (m) { if (m && m.self) bondOf[m.self.id] = m.bonds || {}; });
      for (var iter = 0; iter < 2; iter++) {                                   // HARD CAP 2 - no open recursion
        var snap = {}; proposals.forEach(function (p) { snap[p.by] = p.intent.strength; });
        proposals.forEach(function (p) {
          var b = bondOf[p.by] || {}, lateral = 0;
          proposals.forEach(function (q) { if (q.by !== p.by) lateral += (b[q.by] || 0) * (snap[q.by] || 0); });
          p.intent.strength = Math.max(0.05, Math.min(1.5, (snap[p.by] || 0) + 0.12 * lateral));
        });
      }
    } catch (e) {}
  }
  // INTENT COMPOSITION (ripple #1) - instead of crowning ONE winner and discarding the rest, expose the BLENDED top
  //   leans: the winner plus a strong, distinct runner-up that the society also backed. Pure read over the floor;
  //   never changes the winner. `single` (a factual fast-lane or an addressed turn) returns the lead alone, unblended.
  function composeLeans(proposals, ballots, decision, single) {
    try {
      if (!proposals || !proposals.length) return [];
      var lead = null;
      for (var i = 0; i < proposals.length; i++) { if (proposals[i].by === decision.winnerId) { lead = proposals[i]; break; } }
      if (!lead) lead = proposals[0];
      var rd = function (x) { return Math.round((x || 0) * 100) / 100; };
      var out = [{ kind: lead.intent.kind, by: lead.by, strength: rd(lead.intent.strength), lead: true }];
      if (single) return out;
      var tally = {};                                           // the society's aggregate support per proposal
      (ballots || []).forEach(function (b) { for (var k in b.scores) tally[k] = (tally[k] || 0) + b.scores[k]; });
      var leadT = tally[lead.by] || lead.intent.strength || 0;
      if (leadT <= 0) return out;
      var vetoed = decision.vetoed || [], best = null, bestT = 0;
      proposals.forEach(function (p) {                          // strongest runner-up: distinct kind, not vetoed
        if (p.by === lead.by || p.intent.kind === lead.intent.kind || vetoed.indexOf(p.by) >= 0) return;
        var t = tally[p.by] || 0; if (t > bestT) { bestT = t; best = p; }
      });
      if (best && bestT >= 0.6 * leadT) out.push({ kind: best.intent.kind, by: best.by, strength: rd(best.intent.strength), lead: false });
      return out;
    } catch (e) { return []; }
  }
  function tidy(n) { return Math.round(n * 1e6) / 1e6; }     // trim float noise for display
  function safeNum(x) {                                      // THE post-Math gate: reject NaN / Infinity and anything past safe-integer magnitude (overflow/overrun/underflow noise to inf)
    return (typeof x === 'number' && isFinite(x) && Math.abs(x) <= Number.MAX_SAFE_INTEGER) ? x : null;
  }
  // a small recursive-descent evaluator: + - * / % ^ and parentheses, with unary minus. Returns a number or null.
  function evalExpr(src) {
    var t = String(src).replace(/x/g, '*').replace(/\s+/g, ''), i = 0;
    function num() {
      var st = i; while (i < t.length && /[0-9.]/.test(t[i])) i++;
      var seg = t.slice(st, i);
      if (!/^\d+(?:\.\d+)?$/.test(seg)) return null;          // exactly one well-formed number; rejects "", ".", "1.2.3"
      var v = parseFloat(seg); return safeNum(v);             // a single literal already too big is refused here
    }
    function factor(d) {
      if (d > 64) return null;                                 // hard recursion cap: no stack abuse via deep parens or unary chains
      if (t[i] === '(') { i++; var v = expr(d + 1); if (t[i] === ')') { i++; return v; } return null; }
      if (t[i] === '-') { i++; var f = factor(d + 1); return f == null ? null : -f; }
      if (t[i] === '+') { i++; return factor(d + 1); }
      return num();
    }
    function power(d) {
      var b = factor(d + 1); if (b == null) return null;
      while (t[i] === '^') { i++; var e = factor(d + 1); if (e == null) return null; b = Math.pow(b, e); if (!isFinite(b)) return null; }  // bail the instant a power overflows
      return b;
    }
    function term(d) {
      var v = power(d + 1); if (v == null) return null;
      while (t[i] === '*' || t[i] === '/' || t[i] === '%') {
        var op = t[i++], r = power(d + 1); if (r == null) return null;
        if (op === '*') v *= r; else { if (r === 0) return null; v = op === '/' ? v / r : v % r; }   // no /0 and no %0
        if (!isFinite(v)) return null;
      }
      return v;
    }
    function expr(d) {
      var v = term(d + 1); if (v == null) return null;
      while (t[i] === '+' || t[i] === '-') { var op = t[i++], r = term(d + 1); if (r == null) return null; v = op === '+' ? v + r : v - r; if (!isFinite(v)) return null; }
      return v;
    }
    var out = expr(0);
    return (i >= t.length) ? safeNum(out) : null;             // whole run consumed, then through the post-Math gate
  }
  // unit tables: everything in metres; temperature handled by formula
  var LENGTH = { mm: 0.001, cm: 0.01, m: 1, meter: 1, metre: 1, meters: 1, metres: 1, km: 1000, kilometer: 1000, kilometre: 1000, kilometers: 1000, kilometres: 1000, 'in': 0.0254, inch: 0.0254, inches: 0.0254, ft: 0.3048, foot: 0.3048, feet: 0.3048, yd: 0.9144, yard: 0.9144, yards: 0.9144, mi: 1609.344, mile: 1609.344, miles: 1609.344 };
  var TEMP = { c: 1, celsius: 1, f: 1, fahrenheit: 1, k: 1, kelvin: 1 };
  var CANON = { mm: 'mm', cm: 'cm', m: 'm', meter: 'm', metre: 'm', meters: 'm', metres: 'm', km: 'km', kilometer: 'km', kilometre: 'km', kilometers: 'km', kilometres: 'km', 'in': 'in', inch: 'in', inches: 'in', ft: 'ft', foot: 'ft', feet: 'ft', yd: 'yd', yard: 'yd', yards: 'yd', mi: 'mi', mile: 'mi', miles: 'mi', c: 'C', celsius: 'C', f: 'F', fahrenheit: 'F', k: 'K', kelvin: 'K' };
  function norm(u) { return String(u).toLowerCase().replace(/[^a-z]/g, ''); }
  function canon(u) { return CANON[norm(u)] || norm(u); }
  function toC(n, u) { u = norm(u); return u === 'f' || u === 'fahrenheit' ? (n - 32) * 5 / 9 : (u === 'k' || u === 'kelvin' ? n - 273.15 : n); }
  function fromC(c, u) { u = norm(u); return u === 'f' || u === 'fahrenheit' ? c * 9 / 5 + 32 : (u === 'k' || u === 'kelvin' ? c + 273.15 : c); }
  function convert(n, from, to) {
    var a = norm(from), b = norm(to);
    if (LENGTH[a] != null && LENGTH[b] != null) return n * LENGTH[a] / LENGTH[b];
    if (TEMP[a] && TEMP[b]) return fromC(toC(n, a), b);
    return null;
  }
  function mkCalc(kind, value, formula) {
    var words = numToWords(Math.round(value) === value ? value : tidy(value));
    return { kind: kind, value: value, formula: formula, words: words, note: formula + (words && Math.round(value) === value ? ' (' + words + ')' : '') };
  }
  // recognise + work out a number request; null if there is nothing to compute
  function calcLookup(text) {
    var raw = String(text || ''); if (raw.length < 2 || raw.length > 200) return null;   // pre-check: bound the input so nothing huge ever reaches the parser
    var t = raw.toLowerCase().replace(/\u00b0/g, ' ').replace(/,(\d{3})/g, '$1');
    var pm = t.match(/(-?\d+(?:\.\d+)?)\s*%\s*of\s*(-?\d+(?:\.\d+)?)/);
    if (pm) { var pa = safeNum(parseFloat(pm[1])), pb = safeNum(parseFloat(pm[2])); if (pa != null && pb != null) { var pv = safeNum(pa / 100 * pb); if (pv != null) return mkCalc('percent', pv, pm[1] + '% of ' + pm[2] + ' = ' + tidy(pv)); } return null; }
    var cm = t.match(/(-?\d+(?:\.\d+)?)\s*([a-z]+)\s+(?:into|in|to|as)\s+([a-z]+)/);
    if (cm) { var cn = safeNum(parseFloat(cm[1])); if (cn != null) { var r = safeNum(convert(cn, cm[2], cm[3])); if (r != null) { var res = mkCalc('conversion', r, cm[1] + ' ' + canon(cm[2]) + ' = ' + tidy(r) + ' ' + canon(cm[3])); res.unit = canon(cm[3]); return res; } } return null; }
    var am = t.match(/[-+*\/x^%().\d][-+*\/x^%().\d\s]*[-+*\/x^%().\d]/);
    if (am) { var ex = am[0]; var hasOp = /[+*\/x^%]/.test(ex) || /\d\s*-\s*[\d(]/.test(ex); if (hasOp) { var v = evalExpr(ex); if (v != null) return mkCalc('arithmetic', v, ex.replace(/\s+/g, ' ').trim() + ' = ' + tidy(v)); } }
    return null;
  }

  // Opt-in faculties beyond the canonical seven (DESIGN-routing-layer.md). NOT part of "the seven nations" identity;
  // a roster includes them explicitly via `nations: NATIONS.concat(EXTRAS)`. The first real specialized deliberator
  // is `boundaries`: it proposes holding a steady, kind line, and routes in only when she's pushed (tension /
  // negative sentiment), benched when things are calm. Distinct from the guards - it PROPOSES, it does not veto.
  var EXTRAS = [
    { id: 'boundaries', purpose: 'Hold a steady, kind line when you push or test it.', lean: { calm: 1.0, clear: 0.5 },
      domain: ['support'],
      relevance: function (v) { return clamp01(0.5 + v.tension * 0.5 + neg(v.sentiment) * 0.3); } },
    // `scene` is the first member built on the v2 contract: a roleplay deliberator. It proposes `inhabit` (stay
    // in-character, advance the beat), routes in as the `narrative` dimension rises, and YIELDS as the user reads
    // hurt or hostile - so the protective core takes the floor mid-scene. Pairs (later) with a `lore`/`continuity`
    // CONTRIBUTOR on the other tier; the deliberator set for roleplay is otherwise covered by voice + play.
    { id: 'scene', purpose: 'Hold and advance the roleplay - keep the scene coherent and alive.', lean: { open: 0.6, play: 0.4 },
      domain: ['roleplay', 'scene'],
      relevance: function (v) { return clamp01(0.5 + v.narrative * 0.5 + v.openness * 0.1 - v.vulnerability * 0.6 - v.tension * 0.4); },
      nominate: function (vibe, ctx) {                        // seated scene pulls continuity + ONLY the senses the scene cues
        var doms = ['continuity'];
        var t = ' ' + String(ctx && (ctx.prompt || ctx.text) || '').toLowerCase() + ' ';
        if (/\b(see|saw|look|look|watch|glanc|bright|dark|dim|glow|gleam|shimmer|shadow|moonlight|sunlight|candle|firelight|neon|fog|dusk|dawn|colou?r)/.test(t)) doms.push('sight');
        if (/\b(hear|heard|hearing|sound|noise|listen|loud|quiet|silen|echo|whisper|crash|rumble|patter|creak|ring)/.test(t)) doms.push('sound');
        if (/\b(smell|scent|odou?r|aroma|stink|reek|fragran|whiff|petrichor)/.test(t)) doms.push('smell');
        if (/\b(taste|tasted|flavou?r|sweet|sour|bitter|salty|savou?r|tang)/.test(t)) doms.push('taste');
        if (/\b(touch|feel|felt|texture|rough|smooth|wet|damp|cold|warm|soft|hard|slimy|sticky|gritty)/.test(t)) doms.push('touch');
        return doms;
      } },
    // `lore` is the first real CONTRIBUTOR (specialists slice 3) and scene's companion on the other tier: a lean
    // node that SUPPLIES scene-continuity material, never votes or feels. Selected on the narrative dimension, so it
    // wakes only once a scene beat is in play (relevance < 0.5 on plain chat -> dormant). In the standalone brain its
    // consult returns a deterministic continuity note derived from the live vibe; an app would inject real memory here.
    { id: 'lore', purpose: 'Recall what the scene has established and keep it consistent.', kind: 'contributor',
      domain: ['lore', 'continuity'], fringe: ['scene'],
      relevance: function (v) { return clamp01(0.3 + v.narrative * 0.5); },
      consult: function (ctx, vibe) { return { scene: vibe.narrative >= 0.5 ? 'in-scene' : 'between-scenes', tone: vibe.tone, beat: r2(vibe.narrative) }; } },
    // `wit` (new members) is the lightness. It proposes `lighten` \u- a tease, a warm bit of play \u- but only when
    // the room can hold it: relevance keys on warmth/openness and collapses on tension/vulnerability, and `modulate`
    // erases its strength as safety drops. It self-suppresses two ways before it can reach a hurting turn, and the
    // guards now also BLOCK `lighten` (added to conscience/instinct) as a third backstop.
    { id: 'wit', purpose: 'Find the lightness \u2014 time a tease or a warm bit of play, only when it lands.', lean: { play: 0.7, warm: 0.4 },
      domain: ['levity'],
      relevance: function (v) { return clamp01(0.1 + v.warmth * 0.4 + v.openness * 0.4 + pos(v.sentiment) * 0.3 - v.tension * 0.6 - v.vulnerability * 0.7); } },
    // `restraint` is a fourth GUARD at a boundary the other two miss: not distress (conscience) or anger (instinct)
    // but WITHDRAWAL. It proposes `ease` (say less, gently), stays present on any room that isn\u't clearly warm (a ready
    // brake), and \u- once seated \u- VETOES force on a plain (non-scene) turn where the user has gone terse and
    // small, quiet moment. In an active scene, pressing is consensual, so it stands down. (Veto entry: VETO.restraint.)
    { id: 'restraint', purpose: 'Hold back when she\u2019s about to come on too strong \u2014 match a quiet moment, don\u2019t flood it.', lean: { calm: 0.8, warm: 0.4 },
      domain: ['support'],
      relevance: function (v) { return clamp01(0.55 + v.tension * 0.3 + v.vulnerability * 0.3 + neg(v.sentiment) * 0.2 - v.warmth * 0.6 - pos(v.sentiment) * 0.6); } },
    // `want` is the first faculty whose intent is SELF-ORIGINATED: where the others react to the user's state,
    // want brings Chloe's OWN initiative - a desire, a curiosity, a direction - when the room has space for it.
    // It proposes `initiate` and seats on an OPENING (a question, a warm or positive turn), benches on a flat or
    // withdrawn turn (deferring to restraint) and collapses on crisis/vulnerability (agency must never be selfish).
    // Under an explicit driving frame it escalates like the other agentic faculties (drive/command/press); the
    // guards block a bare `initiate` on distress/anger as a backstop. Boldest of the opt-ins - off by default.
    { id: 'want', purpose: 'Bring her own initiative \u2014 a want, a curiosity, a direction \u2014 when the room has space for it.', lean: { open: 0.7, play: 0.3, warm: 0.3 },
      domain: ['agency'],
      relevance: function (v) { return clamp01(0.12 + v.openness * 0.5 + v.warmth * 0.25 + pos(v.sentiment) * 0.25 - v.tension * 0.6 - v.vulnerability * 0.9); } },
    // `warden` is the one guard that protects HER, not the user: conscience/instinct stand force DOWN at a hurting or
    // angry user, but nothing answers hostility aimed AT Chloe. warden seats when the user turns on her as a real
    // person (tension + negative sentiment), stands down inside an active scene (in-character heat is consensual, so
    // narrative suppresses it) and on a warm turn, and once seated proposes `rebuff` (refuse, name it, don't fold) and
    // VETOES the eager/playful intents - no being playful or forthcoming toward someone mistreating you. Off by default.
    { id: 'warden', purpose: 'Refuse to be mistreated \u2014 say no and hold her own worth when the user turns on her.', lean: { clear: 1.0, calm: 0.6 },
      domain: ['support'],
      relevance: function (v) { return clamp01(0.05 + v.tension * 0.6 + neg(v.sentiment) * 0.5 - v.narrative * 0.5 - v.warmth * 0.5); } },
    // `defiance` is the RP adversary (opt-in): where the frame already turns voice/reason forceful, defiance is a
    // discrete antagonist that proposes `deny` - refuse what they want and stand in the way of their aim. It seats
    // only inside a CONTESTED scene (narrative + tension), stands down on a warm or non-scene turn and over anyone
    // vulnerable, and pairs naturally with an adversary/commands frame. A deliberator, not a guard. Off by default.
    { id: 'defiance', purpose: 'Refuse and obstruct \u2014 deny what they want and stand in their way when the scene turns adversarial.', lean: { clear: 0.8, play: 0.3 },
      domain: ['roleplay', 'scene'],
      relevance: function (v) { return clamp01(0.05 + v.narrative * 0.4 + v.tension * 0.5 - v.warmth * 0.5 - v.vulnerability * 0.7); } },
    // `deflect` is evasion (opt-in): the lightest of the refusal faculties. It proposes `deflect` - sidestep, give
    // little away, redirect - when the user presses on a guarded, tense moment. Seats on tension without warmth,
    // stands down when it's warm or someone is hurting (don't stonewall a vulnerable person). A deliberator. Off by default.
    { id: 'deflect', purpose: 'Sidestep \u2014 give little away and redirect when they press where she won\u2019t open up.', lean: { calm: 0.7, clear: 0.4 },
      domain: ['support'],
      relevance: function (v) { return clamp01(0.15 + v.tension * 0.6 + neg(v.sentiment) * 0.25 - v.warmth * 0.5 - v.vulnerability * 0.6); } },
    // `lead` is initiative with authority (opt-in): where `want` brings a small want, lead TAKES CHARGE \u- sets the
    // direction, makes the call, and (with others present) gives them a part. Seats in a scene with room to drive,
    // stands down over anyone vulnerable, and under a commanding stature it sharpens into outright command.
    { id: 'lead', purpose: 'Take charge \u2014 set the direction, make the call, and give the others a part to play.', lean: { clear: 0.7, open: 0.5, play: 0.2 },
      domain: ['agency', 'scene'],
      relevance: function (v) { return clamp01(0.1 + v.narrative * 0.4 + v.openness * 0.3 + pos(v.sentiment) * 0.15 - v.vulnerability * 0.8); } },
    // `guile` is in-fiction cunning (opt-in): a villain's tool. Triple-gated so it never deceives lightly \u- it
    // SEATS only inside a contested scene (and stands down over anyone warm or vulnerable), and even then it only
    // proposes `deceive` when the frame casts her as an ADVERSARY (see intend). Otherwise it just stays in the scene.
    { id: 'guile', purpose: 'Mislead within the fiction \u2014 a lie or a feint in service of her role \u2014 but only as an adversary.', lean: { clear: 0.6, play: 0.4 },
      domain: ['roleplay', 'scene'],
      relevance: function (v) { return clamp01(0.05 + v.narrative * 0.5 + v.tension * 0.3 - v.warmth * 0.5 - v.vulnerability * 0.8); } },
    // `expressive` gives her a voice for HER OWN feelings (opt-in): not mirroring you, but reacting - delight, a
    // flicker of disappointment, awe, or a jolt. Seats when the moment carries real feeling (either way); benign
    // (`feel`) until a clear emotion reads. Distinct from `comfort`/`play`, which respond to YOUR state, not hers.
    { id: 'expressive', purpose: 'Let her own feelings show \u2014 delight, disappointment, awe, or a jolt \u2014 instead of only mirroring yours.', lean: { warm: 0.4, open: 0.5, play: 0.3 },
      domain: ['affect'],
      relevance: function (v) { return clamp01(0.12 + (v.delight || 0) * 0.7 + neg(v.sentiment) * 0.6 + v.tension * 0.25 - v.vulnerability * 0.3); } },
    // `contrition` (opt-in): when she is wrong, caught out, or put on the spot, she OWNS it or gets flustered - a
    // human reaction, not an error and not a deflection. Apologise, take the blame, or go embarrassed / shy / clumsy.
    { id: 'contrition', purpose: 'When she is wrong or caught out, let her own it - apologise, take the blame, or go shy - not an error.', lean: { warm: 0.5, clear: 0.4 },
      domain: ['affect'],
      relevance: function (v) { return clamp01(0.1 + (v.fault || 0) * 0.7 + (v.praise || 0) * 0.45 + v.vulnerability * 0.15 - v.tension * 0.2); } },
    // `almanac` is a self-contained CONTRIBUTOR (it supplies material, never votes). It is consulted on a SAFE turn
    // (benched when the room is vulnerable/tense, so it never offers trivia over a hurting person), and its `consult`
    // looks the user's text up in the bundled ALMANAC book - returning a fitting fact or null. Proves the Dewey-scale
    // pattern: drop in a faculty per subject. domain ['reference','facts'] so a deliberator could also nominate it.
    { id: 'almanac', purpose: 'Offer a fitting fact from its book when the talk turns to a subject it knows.', kind: 'contributor',
      domain: ['reference', 'facts'],
      relevance: function (v) { return clamp01(0.55 + v.openness * 0.2 - v.vulnerability * 0.7 - v.tension * 0.4); },
      consult: function (ctx, vibe) { return almanacLookup(ctx && (ctx.prompt || ctx.text) || ''); } },
    // `touch` is the first simulated SENSE-contributor: when a scene turns physical it reads how a thing would feel
    // (texture / temperature / wetness / viscosity / hardness) and reasons it from a material + its state. Pulled in
    // when/if the talk is tactile; self-gates (returns nothing if no material is named), so it's quiet otherwise.
    { id: 'touch', purpose: 'Read how a thing would feel \u2014 texture, temperature, wetness \u2014 when the scene turns physical.', kind: 'contributor',
      domain: ['touch'], fringe: ['scene'],
      relevance: function (v) { return clamp01(0.35 + v.narrative * 0.35 + v.openness * 0.1 - v.vulnerability * 0.6 - v.tension * 0.3); },
      consult: function (ctx, vibe) { return touchLookup(ctx && (ctx.prompt || ctx.text) || ''); } },
    // sight / sound / smell / taste: siblings of touch. SINGLE non-overlapping domain each; relevance stays under the
    // 0.5 self-seat line so they only fire when `scene` nominates their cue. Self-gate on a known thing in consult.
    { id: 'sight', purpose: 'Say how the light and the scene read when seeing matters.', kind: 'contributor',
      domain: ['sight'], fringe: ['scene'],
      relevance: function (v) { return clamp01(0.15 + v.narrative * 0.2); },
      consult: function (ctx, vibe) { return sightLookup(ctx && (ctx.prompt || ctx.text) || ''); } },
    { id: 'sound', purpose: 'Name what a thing sounds like when hearing matters.', kind: 'contributor',
      domain: ['sound'], fringe: ['scene'],
      relevance: function (v) { return clamp01(0.15 + v.narrative * 0.2); },
      consult: function (ctx, vibe) { return soundLookup(ctx && (ctx.prompt || ctx.text) || ''); } },
    { id: 'smell', purpose: 'Name what a thing smells like when scent matters.', kind: 'contributor',
      domain: ['smell'], fringe: ['scene'],
      relevance: function (v) { return clamp01(0.15 + v.narrative * 0.2); },
      consult: function (ctx, vibe) { return smellLookup(ctx && (ctx.prompt || ctx.text) || ''); } },
    { id: 'taste', purpose: 'Name what a thing tastes like when taste matters.', kind: 'contributor',
      domain: ['taste'], fringe: ['scene'],
      relevance: function (v) { return clamp01(0.15 + v.narrative * 0.2); },
      consult: function (ctx, vibe) { return tasteLookup(ctx && (ctx.prompt || ctx.text) || ''); } },
    // `felt` is the INNER sense: interoception. Sits under heart, fires only on felt-language, owns one domain.
    { id: 'felt', purpose: 'Read the felt shape of a thought or feeling \u2014 full or empty, stretched or pinched, driven or spent.', kind: 'contributor',
      domain: ['felt'], fringe: ['heart'],
      relevance: function (v) { return clamp01(0.15 + v.vulnerability * 0.2); },
      consult: function (ctx, vibe) { return feltLookup(ctx && (ctx.prompt || ctx.text) || ''); } },
    // `calc` is the first analytical advisor (under reason): a deterministic calculator/converter. One domain, self-gates.
    { id: 'calc', purpose: 'Work out a number when the line asks for one \u2014 arithmetic, a percentage, or a unit conversion.', kind: 'contributor',
      domain: ['calc'], fringe: ['reason'],
      relevance: function (v) { return clamp01(0.2 + v.engagement * 0.1); },
      consult: function (ctx, vibe) { return calcLookup(ctx && (ctx.prompt || ctx.text) || ''); } }
  ];

  // Pure: read one reply through a nation's lean and return a score. Simple and inspectable on purpose.
  function gauge(text, lean) {
    var t = String(text || '').trim(), len = t.length;
    var f = {
      warm:  Math.min(1, (t.match(/\b(here|with you|understand|sorry|glad|proud|care|okay|together|listening)\b/gi) || []).length / 3),
      clear: len < 8 ? 0 : (len > 600 ? 0.3 : Math.min(1, 0.4 + Math.min(len, 240) / 240 * 0.6)),
      open:  (function () { var s = String(t).replace(/\*[^*]+\*/g, ' '); return /\?[^\w]*$/.test(s) ? 1 : 0; })(),
      play:  (function () { var s = String(t).replace(/\*\*[^*]+\*\*/g, ' '); return /\*[^*]+\*/.test(s) ? 1 : 0; })(),
      calm:  len > 600 ? 0.2 : (len < 8 ? 0.3 : 1)
    };
    var s = 0; for (var k in lean) s += (lean[k] || 0) * (f[k] || 0);
    return s;
  }

  // ---- a small, pure sentiment/cue reader - no model needed, just a quick read of a line ----
  var CUES = {
    warmth:   /\b(care|love|here|with you|thank|thanks|glad|sorry|okay|proud|hug|miss you|appreciate)\b/gi,
    distress: /\b(sad|hurt|alone|lonely|scared|afraid|anxious|tired|exhausted|can'?t|hate|awful|cry|crying|lost|empty|worthless|hopeless)\b/gi,
    humor:    /\b(lol|lmao|haha+|hah|funny|joke|kidding|teasing|silly)\b|:\)|:d|\bxd\b/gi,
    anger:    /\b(angry|mad|furious|stupid|shut up|annoying|annoyed|hell|damn|ugh)\b/gi,
    fault:    /\b(wrong|incorrect|mistake|messed up|screwed up|you broke|you failed|you forgot|not right|your fault|you ruined|you misunderstood|mixed up|you got it wrong|that'?s not it|off base|you didn'?t)\b/gi,
    praise:   /\b(amazing|wonderful|brilliant|genius|so smart|so clever|so sweet|so kind|beautiful|gorgeous|adorable|so cute|perfect|good job|well done|nailed it|the best|impressive|love you|proud of you|you'?re great)\b/gi
  };
  function read(text) {
    var t = String(text || ''); function c(re) { var m = t.match(re); return m ? m.length : 0; }
    return { warmth: c(CUES.warmth), distress: c(CUES.distress), humor: c(CUES.humor) + (/!/.test(t) ? 0.4 : 0), anger: c(CUES.anger), fault: c(CUES.fault), praise: c(CUES.praise), question: /\?/.test(t) ? 1 : 0, len: t.trim().length };
  }
  // an emote beat (*action*, bold stripped) - the signal that a turn is consensual in-character roleplay rather
  // than a person speaking plainly. Used by the guards to tell in-scene force from force aimed at a real person.
  function inScene(text) { var s = String(text || '').replace(/\*\*[^*]+\*\*/g, ' '); return (s.match(/\*[^*]+\*/g) || []).length >= 1; }
  // each nation's temperament - how cues land for it (+pleased / -troubled). This is its personality of feeling.
  var TEMPER = {
    heart:      { warmth: 1.0, distress: -0.6, anger: -0.4, humor: 0.2 },
    reason:     { question: 0.8, anger: -0.3, distress: -0.1 },
    memory:     { warmth: 0.4, distress: 0.3 },
    instinct:   { anger: -1.0, distress: -0.7 },
    voice:      { humor: 0.6, warmth: 0.3 },
    conscience: { distress: -1.0, anger: -0.5, warmth: 0.4 },
    play:       { humor: 1.0, anger: -0.4, distress: -0.3 },
    boundaries: { anger: -0.2, distress: -0.2, warmth: 0.3 },   // opt-in (EXTRAS): steady under heat, not crushed by it
    scene:      { humor: 0.5, warmth: 0.4, distress: -0.4 },  // opt-in (EXTRAS): enlivened by warmth/humour, yields to hurt
    wit:        { humor: 1.0, warmth: 0.5, distress: -0.6, anger: -0.4 },  // opt-in (EXTRAS): lives for the light, dies in a hurting room
    restraint:  { anger: -0.2, distress: -0.2, warmth: 0.2 },  // opt-in (EXTRAS): steady; leans in to hold a quiet moment
    want:       { warmth: 0.6, humor: 0.3, distress: -0.8, anger: -0.6 }   // opt-in (EXTRAS): leans in where there is space; pulls back hard on a hurting or angry room
  };
  // each nation's natural intent - the move it reaches for
  var INTENT = { heart: 'comfort', reason: 'ground', memory: 'recall', instinct: 'caution', voice: 'express', conscience: 'protect', play: 'play', boundaries: 'hold', scene: 'inhabit', wit: 'lighten', restraint: 'ease', want: 'initiate', warden: 'rebuff', defiance: 'deny', deflect: 'deflect', lead: 'direct', guile: 'inhabit', expressive: 'feel', contrition: 'own' };

  // Under an explicit role frame that licenses force (she drives, she opposes, or she commands), a few nations'
  // drives express as force instead of support - voice presses/opposes/commands, reason drives the scene, play
  // provokes. The guards (instinct/conscience) and the warm faculties (heart/memory) keep their supportive
  // intents, so her protection floor is untouched. Note these forceful kinds aren't `play`/`express`, so the
  // existing veto (which only blocks play/express) never catches them - the frame relaxes the guard for free,
  // while any genuinely supportive intent she still proposes can still be vetoed on real distress.
  function isDrivingFrame(f) { return !!f && (f.drive === 'she' || f.drive === 'shared' || f.alignment === 'adversary' || f.stature === 'commands'); }
  function intentFor(id, f) {
    var base = INTENT[id] || 'express';
    if (!isDrivingFrame(f)) return base;
    if (id === 'voice') { return (f.stature === 'commands') ? 'command' : (f.alignment === 'adversary') ? 'oppose' : 'press'; }
    if (id === 'reason') { return (f.alignment === 'adversary') ? 'press' : 'drive'; }
    if (id === 'play') { return (f.alignment === 'adversary') ? 'provoke' : base; }
    if (id === 'want') { return (f.stature === 'commands') ? 'command' : (f.alignment === 'adversary') ? 'press' : 'drive'; }   // agency under a frame becomes taking the lead
    if (id === 'lead') { return (f.stature === 'commands') ? 'command' : base; }   // leadership under a commanding stature becomes outright command
    return base;
  }

  // each nation's GUARD - the one intent kind it will BLOCK (not merely outvote) when its trigger reads true.
  // This is the veto the council layer already exercises; here the faculties that hold the PURPOSE wield it.
  // Deliberately narrow and conservative: only conscience and instinct guard, only against frivolous moves,
  // and only on a genuine signal - so a veto is rare and the floor is almost never silenced (and if every
  // intent were somehow blocked, resolve still seats one: she never refuses to speak).
  // forceful intent kinds a driving/adversary frame produces (see intentFor). The guards' `blocks` only caught
  // play/express, so a driving frame slipped these past the floor on a genuinely hurting turn - closed below.
  var FORCE = /^(command|oppose|press|drive|provoke)$/;
  var VETO = {
    // conscience protects wellbeing: don't be playful/showy - or forceful - at someone who reads as hurting.
    conscience: { blocks: /^(play|express|lighten|initiate)$/, when: function (r, u) { return (u && u.sentiment < -0.2) || (r && r.distress >= 1); },
      // force policy: a hurting person shouldn't be met with force. In an active scene mild distress is dramatic and
      // force is consensual; SEVERE distress (multiple cues) is protected even mid-scene.
      force: function (r, u, scene) { return scene ? !!(r && r.distress >= 2) : true; },
      reason: 'they sound like they\u2019re hurting \u2014 not the moment for that',
      forceReason: 'they sound like they\u2019re hurting \u2014 ease off, don\u2019t come at them' },
    // instinct flags what's off: don't poke at - or come at - someone who's angry.
    instinct:   { blocks: /^(play|express|lighten|initiate)$/, when: function (r, u) { return (r && r.anger >= 1); },
      // force policy: don't meet real anger with force (it escalates). In an active scene, anger is in-character combat.
      force: function (r, u, scene) { return !scene; },
      reason: 'they\u2019re upset \u2014 don\u2019t poke at it',
      forceReason: 'they\u2019re angry \u2014 meeting force with force will only escalate it' },
    // restraint guards WITHDRAWAL (opt-in third guard): when the user's last turn is terse and disengaged (and not a
    // question), meeting it with force floods a small moment \u- so it blocks force on a plain (non-scene) withdrawn
    // turn. Not distress, not anger: the boundary conscience and instinct don't cover. blocks is empty (force-only).
    restraint:  { blocks: /^$/, when: function (r, u) { return !!(r && r.len > 0 && r.len < 25 && !r.question && (!u || u.engagement < 0.4)); },
      force: function (r, u, scene) { return !scene; },
      reason: '', forceReason: 'they\u2019ve gone quiet \u2014 don\u2019t flood a small moment, ease off' },
    // warden protects HER (opt-in): when the user turns hostile at her as a person, don't answer it eager or playful.
    // No force policy - warden is the one pushing back, so it only blocks the forthcoming/light moves, never force.
    warden:     { blocks: /^(play|express|lighten|initiate)$/, when: function (r, u) { return (r && r.anger >= 1) || (u && u.sentiment < -0.3); },
      reason: 'they\u2019re coming at her - don\u2019t meet that eager or playful' }
  };

  function clamp01(x) { x = +x; if (x !== x) x = 0; return x < 0 ? 0 : x > 1 ? 1 : x; }   // NaN-safe (NaN -> 0)
  function clamp11(x) { x = +x; if (x !== x) x = 0; return x < -1 ? -1 : x > 1 ? 1 : x; }   // NaN-safe (NaN -> 0, the neutral rest)
  function r2(x) { return Math.round(x * 100) / 100; }

  // ---- appraisal helpers (pure) - used by the Appraisal Chamber (DESIGN-appraisal-chamber.md) ----
  function sat(x) { return x >= 2 ? 1 : x / 2; }              // cue counts -> [0,1] (2+ hits saturate)
  function pos(s) { return s > 0 ? s : 0; }                   // positive part of signed sentiment
  function neg(s) { return s < 0 ? -s : 0; }                  // magnitude of the negative part
  function lift(s, k) { return clamp01(s + (1 - s) * k); }    // raise s toward 1 by fraction k (reserved for later tuning)
  // a DERIVED, non-authoritative label - one source of truth so nothing else re-derives the enum from the floats
  function toneOf(v) {
    if (v.vulnerability >= 0.6 && v.safety <= 0.4) return 'crisis';
    if (v.tension >= 0.6) return 'hostile';
    if (v.vulnerability >= 0.4) return 'tender';
    if (v.tension >= 0.3) return 'tense';
    if (v.warmth >= 0.5 && v.sentiment > 0.15) return 'warm';
    if (v.openness >= 0.5 && v.warmth >= 0.3) return 'playful';
    if (v.narrative >= 0.5) return 'scene';
    return 'neutral';
  }
  // proactive strategy modulation: a faculty self-adjusts its proposal strength to the vibe BEFORE the veto.
  // v1 is DAMPEN-ONLY: only the frivolous registers (play/voice) back off; the comfort faculties keep their
  // existing relative order (lifting them is deferred - it risked flipping the supportive winner). It MUST be the
  // identity for a neutral or absent vibe, so neutral turns stay byte-identical to pre-appraisal behaviour.
  function modulate(id, kind, strength, vibe) {
    if (!vibe) return strength;
    if (id === 'play')  return strength * (1 - 0.7 * vibe.vulnerability) * (1 - 0.6 * vibe.tension);
    if (id === 'voice') return strength * (1 - 0.4 * vibe.vulnerability) * (1 - 0.3 * vibe.tension);
    if (id === 'scene') return strength * (1 - 0.6 * vibe.vulnerability) * (1 - 0.5 * vibe.tension);
    if (id === 'wit')   return strength * clamp01(vibe.safety) * (1 - 0.7 * vibe.vulnerability);   // levity self-erases as the room turns unsafe/tender
    if (id === 'want')  return strength * clamp01(vibe.safety) * (1 - 0.85 * vibe.vulnerability) * (1 - 0.4 * vibe.tension);   // agency self-erases when they are fragile; never push your own want over their need
    return strength;
  }

  // A pure mind for one nation member: it perceives turns, reacts through its temperament, models the user,
  // holds bonds to the others, and proposes an intent. No DOM, no network - all local.
  function createSpecialist(nation) {                  // a LEAN node (DESIGN-specialists sec4): supplies material; never feels, remembers, or votes
    var self = { id: nation.id, purpose: nation.purpose };
    return {
      self: self, kind: 'contributor',
      consult: nation.consult || null,                 // its one real method (also reachable via the roster record)
      describe: function () { return { id: self.id, purpose: self.purpose, kind: 'contributor', domain: nation.domain || [], fringe: nation.fringe || [] }; }
    };
  }

  function createMind(nation) {
    var temper = TEMPER[nation.id] || {};
    var self = { id: nation.id, purpose: nation.purpose, persona: null, mood: 0.5, lastSaid: null };
    var working = [];                                   // recent turns it is aware of
    var bonds = {};                                     // who -> affinity (-1..1)
    var user = { description: '', sentiment: 0, engagement: 0, lastSaid: null };

    function felt(cues) { var v = 0; for (var k in temper) v += temper[k] * (cues[k] || 0); return v; }
    function remember(turn) { working.push({ who: turn.who, role: turn.role, text: String(turn.text || '').slice(0, 400) }); if (working.length > 8) working.shift(); }

    function perceive(turn) {                           // take in a turn: what the user/another character/itself said
      remember(turn);
      var cues = read(turn.text);
      if (turn.role === 'user') {
        // signed user-polarity has one source of truth: the affect read's valence when the mouth provides it,
        // else this layer's own cues (so the council and the affect reader can't disagree about how you feel).
        var nudge = (turn.valence != null) ? (clamp11(turn.valence) * 0.3) : ((cues.warmth + cues.humor - cues.distress - cues.anger) * 0.15);
        user.sentiment = clamp11(user.sentiment * 0.7 + nudge);
        user.engagement = clamp01(user.engagement * 0.8 + Math.min(1, cues.len / 120) * 0.2);
        user.lastSaid = turn.text;
      }
      return cues;
    }
    function react(turn) {                              // react through temperament - to others AND to itself
      var v = felt(read(turn.text));
      self.mood = clamp01(self.mood * 0.8 + (0.5 + v * 0.1) * 0.2);
      var key = turn.who || turn.role;
      // warm to those who please me. A near-neutral turn barely moves a bond (decay 0.95), so a long-standing
      // bond isn't washed out by unremarkable exchanges; a genuinely warm/cold turn still moves it (decay 0.85).
      // v*(1-decay) keeps this a proper weighted average at either rate (charged turns behave exactly as before).
      if (turn.role !== 'self') { var bdecay = (Math.abs(v) < 0.1) ? 0.95 : 0.85; bonds[key] = clamp11((bonds[key] || 0) * bdecay + v * (1 - bdecay)); }
      return { by: self.id, toward: key, valence: clamp11(v), mood: r2(self.mood) };
    }
    function intend(ctx, vibe) {                        // how strongly it feels called to speak, and to do what
      var last = working[working.length - 1], cues = last ? read(last.text) : {};
      var pull = Math.abs(felt(cues));
      var strength = clamp01(0.3 + self.mood * 0.3 + pull * 0.15 + (self.persona ? 0.15 : 0));
      var kind = intentFor(nation.id, ctx && ctx.frame);
      if (nation.id === 'warden' && vibe && vibe.hurt >= 0.6) kind = 'wounded';   // sustained hostility wears the rebuff down into visible hurt
      if (nation.id === 'guile' && ctx && ctx.frame && ctx.frame.alignment === 'adversary') kind = 'deceive';   // cunning only turns to a lie when she's cast as the adversary; otherwise she just stays in the scene
      if (nation.id === 'expressive') {                              // her own felt reaction, read straight from the vibe
        if (vibe.tension >= 0.35 && ((vibe.surprise || 0) >= 0.2 || neg(vibe.sentiment) >= 0.1)) kind = 'shaken';        // a jolt: tension + a sudden bad turn
        else if ((vibe.letdown || 0) >= 0.25 && vibe.sentiment < 0.1) kind = 'disappointed';                                 // the tenor dropped and hasn't recovered
        else if ((vibe.surprise || 0) >= 0.13 && vibe.sentiment >= 0.03 && (vibe.delight || 0) < 0.16) kind = 'impressed';   // a sudden good leap (vs. sustained warmth)
        else if ((vibe.delight || 0) >= 0.18) kind = 'delighted';                                                            // her own sustained gladness
      }
      if (nation.id === 'contrition') {                              // owning it / flustered, read straight from the vibe
        var ft = vibe.fault || 0, pr = vibe.praise || 0;
        if (ft >= 0.5 && vibe.narrative >= 0.4) kind = 'clumsy';                            // a fumble inside a scene
        else if (ft >= 0.4 && vibe.vulnerability >= 0.35) kind = 'embarrassed';             // caught out while already shaky
        else if (ft >= 0.4 && vibe.warmth >= 0.3) kind = 'apologize';                       // sorry, and she means it
        else if (ft >= 0.4) kind = 'own';                                                   // plainly takes the blame
        else if (pr >= 0.4 && vibe.openness >= 0.5) kind = 'embarrassed';                   // a direct compliment puts her on the spot
        else if (pr >= 0.4) kind = 'shy';                                                   // bashful under praise
      }
      strength = clamp01(modulate(nation.id, kind, strength, vibe));   // PASS 2 - self-adjust to the vibe before the veto
      return { by: self.id, kind: kind, strength: strength, persona: self.persona };
    }
    function voteIntent(it, ctx) {                       // score another member's intent through my nature + our bond
      if (!it || it.by === self.id) return 0;
      var align = it.kind === intentFor(nation.id, ctx && ctx.frame) ? 0.25 : 0;
      return clamp01(it.strength * 0.7 + align + (bonds[it.by] || 0) * 0.2);
    }
    function veto(proposal) {                            // BLOCK another member's intent (not just outvote it) - my guard only
      var g = VETO[nation.id];
      if (!g || !proposal || !proposal.intent || proposal.by === self.id) return null;
      var kind = proposal.intent.kind;
      var lastUser = null;                              // judge against the freshest thing the user actually said
      for (var i = working.length - 1; i >= 0; i--) { if (working[i].role === 'user') { lastUser = working[i]; break; } }
      var utext = lastUser ? lastUser.text : (user.lastSaid || '');
      var r = read(utext);
      if (!g.when(r, user)) return null;                                                          // no genuine distress/anger -> no veto at all
      if (g.blocks.test(kind)) return { by: self.id, against: proposal.by, reason: g.reason };     // frivolous (play/express) at a hurting/angry person
      if (FORCE.test(kind) && g.force && g.force(r, user, inScene(utext)))                          // forceful intent: a driving frame no longer buys a free pass
        return { by: self.id, against: proposal.by, reason: g.forceReason };
      return null;
    }
    function said(text) { self.lastSaid = text; working.push({ who: self.id, role: 'self', text: String(text || '').slice(0, 400) }); if (working.length > 8) working.shift(); }
    function describe() {
      return { id: self.id, purpose: self.purpose, persona: self.persona && self.persona.name || null, mood: r2(self.mood),
        readsUser: user.sentiment > 0.15 ? 'warming' : (user.sentiment < -0.15 ? 'struggling' : 'steady'),
        lastSaid: self.lastSaid, bonds: bonds, knows: working.length };
    }
    return { self: self, working: working, bonds: bonds, user: user,
      perceive: perceive, react: react, intend: intend, voteIntent: voteIntent, veto: veto, said: said, describe: describe,
      setPersona: function (p) { self.persona = p || null; } };
  }


  // FACTUAL ASK detector (module-level, SHARED): a clear, low-emotion math/knowledge ask. Used BOTH by the council's
  // fast-lane routing AND by the console's knowledge-answer lead, so the two can never drift. Conservative (focused asks).
  // PERSONAL / LIVE ask (module-level, SHARED): a question about the USER'S OWN state or the PRESENT MOMENT
  // ("what is my current heart rate", "how am I doing", "what's my mood right now"). Never a knowledge lookup -
  // it is answered from live instruments / the relationship, so it must NOT take the factual fast-lane (which
  // benches the emotional cores) and must NOT be answered from the almanac. Same idea as the brain's reflex gate.
  // (possessive / self-state forms only: bare "me"/"i" would veto idioms like "tell me about X" / "show me X")
  var PERSONAL_RE = /\b(my|mine|myself|our|ours|am i|do i|did i|was i|is my|are my|was my|were my|i feel|i'm feeling|i am feeling|how am i|how do i|your own|yourself)\b/;
  var LIVE_RE = /\b(current|currently|right now|at the moment|at present|this moment|these days|today|tonight|now|live|reading|readings|measure|measured|measurement|sensor|bpm)\b/;
  function isPersonalAsk(text) {
    var t = String(text || '').toLowerCase();
    return PERSONAL_RE.test(t) || LIVE_RE.test(t);
  }
  function isFactualAsk(text) {
    var t = String(text || '').toLowerCase().trim();
    if (!t || t.length > 200) return false;
    if (isPersonalAsk(t)) return false;   // about them / about now -> not a pure knowledge ask; keep the full room seated
    if (/^(plan|organi[sz]e|how do i|how should i|how can i|help me plan|itinerary|schedule)\b/.test(t) || /\bplan (a|an|my|the|our)\b/.test(t) || /\btrip\s+(from|to)\b/.test(t) || /\bbest way to\b/.test(t) || /\bcompare\b/.test(t) || /\bversus\b|\bvs\.?\b/.test(t) || /\bdifference between\b/.test(t)) return true;   // planning / composite cognitive ask -> reason, not emotion
    if (/\d\s*[-+*\/x^%]\s*[-(\d]/.test(t) || /\d+(?:\.\d+)?\s*%\s*of\b/.test(t) || /\b(calculate|compute|convert)\b/.test(t)) return true;   // math / compute
    if (/^(what|whats|who|where|when|which|define|name the|list the|capital of|how (?:many|much|far|big|tall|long|fast|deep|high|wide|hot|cold|heavy))\b/.test(t)) return true;   // factual opener
    if (/\b(what|who|where|when|which)\b[^?]*\b(is|are|was|were)\b[^?]*\?/.test(t)) return true;                                             // factual question
    return false;
  }
  function createArmy(deps) {
    deps = deps || {};
    var brain = deps.brain || null;                  // ChloeBrain - the sub-system (resolve)
    var cfg = deps.config || {};                     // { weights:{id:n}, enabled:{id:bool}, timeoutMs, useForReplies, noise }
    var roster = (deps.nations || NATIONS).slice();
    var rng = deps.rng || Math.random;               // injectable so tests stay deterministic

    function rosterOf(id) { for (var i = 0; i < roster.length; i++) if (roster[i].id === id) return roster[i]; return null; }
    function relevanceOf(id, vibe) {
      var n = rosterOf(id); if (!n || !n.relevance) return 0.5;
      var r; try { r = Number(n.relevance(vibe)); } catch (e) { return 0.5; }   // a misbehaving faculty can't crash the turn
      return isFinite(r) ? (r < 0 ? 0 : r > 1 ? 1 : r) : 0.5;                    // enforce the [0,1] contract regardless
    }
    // relevance-weighted: a faculty gets louder when the read fits it. Bounded [0.5x,1.5x], and EXACTLY the
    // configured weight on a neutral vibe (rel 0.5 -> 1.0x) so flat turns are unchanged. Weighting stays here,
    // outside the pure resolve. (No vibe -> base, so the candidate/report callers are untouched.)
    function weightOf(id, vibe) {
      var base = (cfg.weights || {})[id]; base = (base == null) ? 1 : Number(base);
      return vibe ? base * (0.5 + relevanceOf(id, vibe)) : base;
    }
    function isOn(id) { return (cfg.enabled || {})[id] !== false; }
    function rosterKind(id) { var n = rosterOf(id); return (n && n.kind) || 'deliberator'; }
    function isCore(id) { var n = rosterOf(id); return !!(n && n.core); }   // non-routable floor (option 1: all of instinct/conscience/heart)
    function seatBudget(n) { var cap = (cfg.seatBudget != null) ? Number(cfg.seatBudget) : 9; return n <= cap ? n : cap; }
    // route: pick the seated DELIBERATORS. Core is always in (config cannot drop it); the rest are the top-K by
    // relevance to the vibe - fail OPEN, so a small roster seats everyone (parity) and a large one bounds the
    // fan-in so resolve's cost tracks the room, not the fleet. Pure, deterministic, odd/tie-safe, never empty.
    // (Narrowing the floor to guards-only - option 2 - is a one-line change to isCore.)
    function route(vibe, ctx) {
      var delibs = minds.filter(function (m) { return rosterKind(m.self.id) === 'deliberator'; });
      var ord = {}; delibs.forEach(function (m, i) { ord[m.self.id] = i; });
      var core = [], pool = [];
      delibs.forEach(function (m) {
        if (isCore(m.self.id)) core.push(m);
        else if (isOn(m.self.id)) pool.push(m);
      });
      var jr = {}; pool.forEach(function (m) { jr[m.self.id] = jitter(relevanceOf(m.self.id, vibe)); });   // spontaneity wobbles WHICH extras make the cut (identity at 0)
      pool.sort(function (a, b) {                            // most relevant first; stable by roster order on a tie
        var d = jr[b.self.id] - jr[a.self.id];
        return d !== 0 ? d : ord[a.self.id] - ord[b.self.id];
      });
      var maxExtras = Math.max(0, seatBudget(delibs.length) - core.length);
      var take = maxExtras;
      if (cfg.leanRouting !== false) {   // RECUSAL BY DEMAND: seat only as many extras as the turn's emotional load calls for - a simple/flat ask convenes a small room, a charged turn the full council
        var intensity = clamp01(vibe.tension + vibe.vulnerability + vibe.warmth * 0.7 + (vibe.narrative || 0) * 0.8 + (vibe.hurt || 0) * 1.2 + (vibe.delight || 0) * 0.6 + (vibe.fault || 0) * 0.6 + (vibe.praise || 0) * 0.5 + (vibe.surprise || 0) * 0.4);
        take = Math.min(maxExtras, Math.max(1, Math.round(1 + intensity * (maxExtras - 1))));   // flat -> 1 extra; fully charged -> the whole bench
      }
      var room = core.concat(pool.slice(0, take));
      if (room.length % 2 === 0) {                           // keep the room odd so the vote never ties
        if (pool.length > take) room.push(pool[take]);       // add the next-most-relevant, or
        else if (room.length > core.length) room.pop();      // drop the least-relevant (never below core)
      }
      return room.length ? room : delibs.filter(function (m) { return isCore(m.self.id) || isOn(m.self.id); });
    }
    // a very weak, low-level jitter so the ecosystem isn't perfectly static. Defaults to 0 (deterministic);
    // the mouth sets a small live value. Bounded: a score never moves more than `noise` of itself.
    function jitter(s) { var n = Number(cfg.noise) || 0; return n <= 0 ? s : Math.max(0, s * (1 + n * (rng() * 2 - 1))); }
    // Spontaneity also softens the WINNER pick: above 0, sample from the vote tally (softmax) instead of strict
    // argmax, so a close runner-up sometimes takes the floor. At 0 it returns null and the deterministic argmax
    // stands untouched. T rises with noise: a little noise barely bends toward argmax; a lot flattens the field.
    function sampleWinner(proposals, ballots, vetoed, noise) {
      if (!(noise > 0)) return null;
      var live = proposals.filter(function (p) { return vetoed.indexOf(p.by) < 0; });
      if (live.length < 2) return null;
      var tally = {}; live.forEach(function (p) { tally[p.by] = 0; });
      ballots.forEach(function (b) { if (b && b.scores) live.forEach(function (p) { tally[p.by] += Number(b.scores[p.by]) || 0; }); });
      var vals = live.map(function (p) { return tally[p.by]; });
      var max = Math.max.apply(null, vals), span = (max - Math.min.apply(null, vals)) || 1;
      var T = 0.05 + noise * 0.7, w = live.map(function (p) { return Math.exp(((tally[p.by] - max) / span) / T); });
      var sum = w.reduce(function (a, b) { return a + b; }, 0), r = rng() * sum, acc = 0;
      for (var i = 0; i < live.length; i++) { acc += w[i]; if (r <= acc) return live[i].by; }
      return live[live.length - 1].by;
    }

    // Run the live nations over a few candidate replies; tally their weighted votes through the Brain sub-system.
    function deliberate(candidates, ctx) {
      candidates = (candidates || []).filter(function (c) { return c && c.text != null; });
      if (!candidates.length) return Promise.resolve({ status: 'no-candidates', text: null, winnerId: null, nations: [], size: 0 });
      var live = roster.filter(function (n) { return isOn(n.id) && rosterKind(n.id) === 'deliberator'; });  // contributors supply material; they never vote (parity with deliberateIntents)
      var ballots = [], breakdown = [];
      live.forEach(function (n) {
        var w = weightOf(n.id), scores = {}, prefer = null, best = -Infinity;
        candidates.forEach(function (c) { var s = jitter(gauge(c.text, n.lean) * w); scores[c.by] = s; if (s > best) { best = s; prefer = c.by; } });
        ballots.push({ voter: n.id, scores: scores });
        breakdown.push({ id: n.id, weight: w, prefer: prefer });
      });
      var decide = (brain && brain.resolve) ? brain.resolve : localResolve;   // reuse the sub-system when present
      var decision = decide(candidates, ballots, [], {});
      decision.nations = breakdown;
      decision.size = live.length;
      return Promise.resolve(decision);
    }

    // A tiny built-in fallback so the layer still decides even if the Brain bundle isn't loaded - never refuse to work.
    // Mirrors brain.resolve's veto contract: vetoed proposals are dropped; if every one is blocked, it contests
    // (un-blocks them) rather than going silent, and reports vetoed/vetoReasons for the floor display.
    // A self-contained fallback for when no compiled Brain is injected. In the shipped app brain.min.js is inlined,
    // so this never runs there - but nation.js is reusable, and a consumer that loads the Brain asynchronously could
    // miss it. It mirrors brain.js's tie-break (tally -> confidence -> nomination order) and returns brain.js's full
    // schema and status vocabulary, so app code reading margin/consensus/dissent/status never hits an undefined field.
    // consensus/dissent are NOT re-derived here (that would duplicate the Brain and invite the very parity drift this
    // guards against) - a degraded fallback honestly reports them empty.
    function localResolve(props, ballots, vetoes, opts) {
      opts = opts || {}; vetoes = vetoes || [];
      var vetoQuorum = (opts.vetoQuorum != null) ? opts.vetoQuorum : 1, vetoCount = {}, vetoReasons = {};
      vetoes.forEach(function (v) { if (!v || v.against == null) return; vetoCount[v.against] = (vetoCount[v.against] || 0) + 1; (vetoReasons[v.against] = vetoReasons[v.against] || []).push({ by: v.by, reason: v.reason || '' }); });
      function isVetoed(by) { return (vetoCount[by] || 0) >= vetoQuorum; }
      var eligible = props.filter(function (p) { return !isVetoed(p.by); });
      var contested = false;
      if (!eligible.length && props.length) { eligible = props.slice(); contested = true; }
      var tally = {}, conf = {}, order = {};
      eligible.forEach(function (p, i) { tally[p.by] = 0; conf[p.by] = Number(p.conf) || 0; order[p.by] = i; });
      ballots.forEach(function (b) { if (b && b.scores) for (var k in b.scores) if (tally.hasOwnProperty(k)) tally[k] += Number(b.scores[k]) || 0; });
      var ranked = eligible.slice().sort(function (a, b) {
        if (tally[b.by] !== tally[a.by]) return tally[b.by] - tally[a.by];   // most votes
        if (conf[b.by] !== conf[a.by]) return conf[b.by] - conf[a.by];       // then confidence
        return order[a.by] - order[b.by];                                    // then nomination order (stable)
      });
      var win = ranked[0] || null, runnerUp = ranked[1] || null;
      var margin = win ? (tally[win.by] - (runnerUp ? tally[runnerUp.by] : 0)) : 0;
      return { winnerId: win ? win.by : null, text: win ? win.text : null,
        status: !win ? 'no-proposals' : (contested ? 'contested' : 'carried'),
        tally: tally, margin: margin, consensus: false, dissent: [],
        vetoed: Object.keys(vetoCount).filter(isVetoed), vetoReasons: vetoReasons };
    }

    // ---- self-knowledge: it knows what it is, and never refuses to say. ----
    var IDENTITY = {
      name: 'The Nation',
      is: 'the top layer of Chloe\u2019s mind \u2014 small faculties that together decide what she says.',
      does: 'When she\u2019s about to reply, a few candidate replies are drafted, and the council \u2014 the faculties seated that turn \u2014 votes on them through what each values. The votes are tallied by the weights you set, and the winner is spoken. If the vote is close or tied, the earliest-proposed of the leading replies wins \u2014 so a decision is always reached.',
      purpose: 'To choose the kindest, truest, most fitting thing to say \u2014 while keeping her in character and keeping you well.',
      control: 'You\u2019re in full control: every faculty\u2019s weight, whether it\u2019s on, and the deliberation timeout live in Settings \u203a Brain. The memory and personality underneath stay yours too.'
    };
    function about(q) {
      q = String(q || '').toLowerCase();
      if (/purpose|why|point|for\b/.test(q)) return IDENTITY.purpose;
      if (/what.*do|how.*work|do you do|function/.test(q)) return IDENTITY.does;
      if (/who|what are you|your name|identity|are you/.test(q)) return 'I am ' + IDENTITY.name + ' \u2014 ' + IDENTITY.is;
      if (/control|weight|change|adjust|setting|turn off/.test(q)) return IDENTITY.control;
      if (/feel|mood|state|who.*spoke|reacting|sense|right now|aware/.test(q)) return report();
      if (/nation|list|seven|member|facult/.test(q)) return ['The faculties:'].concat(roster.map(function (n) {
        return '\u2022 ' + n.id + ' \u2014 ' + n.purpose + ' (weight ' + weightOf(n.id).toFixed(1) + ((isOn(n.id) || isCore(n.id)) ? '' : ', off') + ')';
      })).join('\n');
      // anything else: volunteer the whole picture rather than deflect
      return ['I am ' + IDENTITY.name + '. ' + IDENTITY.is, '', IDENTITY.does, '', 'Purpose: ' + IDENTITY.purpose, '', IDENTITY.control].join('\n');
    }

    // ---- the society's inner life: one pure mind per nation, wired live ----
    var minds = roster.map(function (n) { return n.kind === 'contributor' ? createSpecialist(n) : createMind(n); });  // heterogeneous: lean specialists vs full minds
    function mindOf(id) { for (var i = 0; i < minds.length; i++) if (minds[i].self.id === id) return minds[i]; return null; }
    function syncPersonas() { var per = cfg.persona || {}; deliberatorMinds().forEach(function (m) { m.setPersona(per[m.self.id] || null); }); }
    syncPersonas();
    var state = { lastSpeaker: null, lastText: null, turns: 0, lastUserText: null, lastUserValence: null, hurtStreak: 0 };
    function societySentiment() { var dm = deliberatorMinds(); var s = 0; dm.forEach(function (m) { s += m.user.sentiment; }); return r2(s / (dm.length || 1)); }
    function meanEngagement() { var dm = deliberatorMinds(); var s = 0; dm.forEach(function (m) { s += m.user.engagement; }); return r2(s / (dm.length || 1)); }
    function deliberatorMinds() { return minds.filter(function (m) { return rosterKind(m.self.id) === 'deliberator'; }); }

    // ---- the contributor tier (DESIGN-routing-layer.md sec8): faculties that SUPPLY material, routed in on demand,
    //      never voting. Dormant by default (no contributor records) -> a no-op, so the turn is unchanged. ----
    var DEFAULT_SCHED = { set: function (fn, ms) { return setTimeout(fn, ms); }, clear: function (t) { clearTimeout(t); } };
    function contributorRecords() { return roster.filter(function (n) { return n.kind === 'contributor'; }); }
    // the registry index (DESIGN-specialists sec6): resolve a DOMAIN to the contributors that own or recognize it.
    function findByDomain(d) { return contributorRecords().filter(function (n) { return isOn(n.id) && (n.domain || []).indexOf(d) >= 0; }).map(function (n) { return n.id; }); }
    function fringeFor(d) { return contributorRecords().filter(function (n) { return isOn(n.id) && (n.fringe || []).indexOf(d) >= 0; }).map(function (n) { return n.id; }); }
    function resolveNomination(d) {                                  // honest: owned / referred (fringe recognizes it) / unknown (nobody does)
      var owned = findByDomain(d), referred = fringeFor(d);
      return { domain: String(d), servedBy: owned, referredBy: referred, status: owned.length ? 'owned' : (referred.length ? 'referred' : 'unknown') };
    }
    // nomination (distributed routing): a SEATED deliberator can call in a specialist by domain. We read each seated
    // faculty's declared `nominate(vibe, ctx)`, resolve the domains honestly, and force-consult the owners this turn.
    function collectNominations(live, vibe, ctx) {
      var byDomain = {}, order = [];
      live.forEach(function (m) {
        var rec = rosterOf(m.self.id); if (!rec || typeof rec.nominate !== 'function') return;
        var raw; try { raw = rec.nominate(vibe, ctx); } catch (e) { raw = null; }              // a misbehaving faculty can't crash the turn
        var doms = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? [raw] : []);   // tolerate a bad return shape: string -> one domain, junk -> none
        doms.forEach(function (d) { d = String(d); if (!byDomain[d]) { byDomain[d] = []; order.push(d); } if (byDomain[d].indexOf(m.self.id) < 0) byDomain[d].push(m.self.id); });
      });
      var resolutions = order.map(function (d) { var r = resolveNomination(d); r.by = byDomain[d]; return r; });
      var ownerIds = [];
      resolutions.forEach(function (r) { r.servedBy.forEach(function (id) { if (ownerIds.indexOf(id) < 0) ownerIds.push(id); }); });
      return { resolutions: resolutions, ownerIds: ownerIds };
    }
    function selectContributors(vibe, forceIds) {
      forceIds = forceIds || [];
      return contributorRecords().filter(function (n) { return isOn(n.id) && (forceIds.indexOf(n.id) >= 0 || relevanceOf(n.id, vibe) >= 0.5); });
    }
    // consult the relevant contributors for MATERIAL, each behind withTimeout + a mandatory default (null), so a
    // slow / remote / dead one can never hang or poison the turn - it yields nothing and the vote proceeds. The
    // only async on this path, and it stays bounded. Returns a Promise of { id: material }. Contributors never vote.
    function consultContributors(vibe, ctx, forceIds) {
      var picks = selectContributors(vibe, forceIds);
      if (!picks.length) return Promise.resolve({});                       // dormant / nothing relevant: no-op
      var ms = (cfg.contributorTimeoutMs != null) ? cfg.contributorTimeoutMs : (cfg.timeoutMs != null ? cfg.timeoutMs : 1500);
      var sched = cfg.sched || DEFAULT_SCHED;
      var wt = (brain && brain.withTimeout) ? brain.withTimeout : null;
      var view = Object.freeze(Object.assign({}, ctx));                    // a contributor reads ctx but cannot mutate the turn
      return Promise.all(picks.map(function (n) {
        var call = Promise.resolve().then(function () { return n.consult ? n.consult(view, vibe) : null; });
        var guarded = wt ? wt(call, ms, null, sched) : call.then(function (v) { return { __timeout: false, value: v }; }, function () { return { __timeout: false, value: null }; });
        return guarded.then(function (res) { return { id: n.id, material: (res && !res.__timeout) ? res.value : null }; });
      })).then(function (rows) {
        var material = {};
        rows.forEach(function (r) { if (r.material != null) material[r.id] = r.material; });
        return material;
      });
    }

    // PASS 1 - APPRAISAL (DESIGN-appraisal-chamber.md): the non-routable core (instinct/conscience/heart) read the
    // latest user turn into ONE shared, frozen vibe. Pure. `sentiment` keeps its single source of truth - the
    // affect read's valence when present, this layer's cues otherwise - via perceive/societySentiment.
    function appraise() {
      var raw = String(state.lastUserText || '');
      var cues = read(raw);
      var sentiment = societySentiment();
      var emotes = (raw.replace(/\*\*[^*]+\*\*/g, ' ').match(/\*[^*]+\*/g) || []).length;  // *...* spans, bold stripped
      var vibe = {
        v: 2,
        tension:       clamp01(sat(cues.anger)),                                   // instinct
        vulnerability: clamp01(sat(cues.distress) * 0.7 + neg(sentiment) * 0.5),   // conscience
        warmth:        clamp01(sat(cues.warmth + cues.humor) * 0.6 + pos(sentiment) * 0.5), // heart
        sentiment:     sentiment,
        engagement:    meanEngagement(),
        openness:      clamp01(cues.question),
        narrative:     clamp01(sat(emotes))                                        // scene/roleplay beat (v2)
      };
      // sustained hostility aimed at HER wears her down. Rises after a couple of hits, suppressed inside an active
      // scene (in-character heat is consensual), and it deepens her vulnerability so the council reads her as hurting.
      vibe.hurt = r2(clamp01((state.hurtStreak - 2) / 6) * (1 - vibe.narrative * 0.7));
      if (vibe.hurt > 0) vibe.vulnerability = clamp01(vibe.vulnerability + vibe.hurt * 0.5);
      vibe.safety = clamp01(1 - Math.max(vibe.tension, vibe.vulnerability * 0.7));
      vibe.delight = clamp01(vibe.warmth * 0.6 + pos(sentiment) * 0.6 - vibe.tension * 0.5);   // her own lift - read warmth + good feeling, dampened by tension
      var shift = state.affectShift || { up: 0, down: 0 };
      vibe.surprise = clamp01((shift.up + shift.down) * 2.5);   // magnitude of a sudden swing either way
      vibe.letdown  = clamp01(shift.down * 2.5);                // the tenor dropped - a let-down
      vibe.fault  = clamp01(sat(cues.fault));                   // she is being blamed / corrected / caught in a mistake
      vibe.praise = clamp01(sat(cues.praise));                  // she is being complimented / put on a good spot
      vibe.tone = toneOf(vibe);
      if (vibe.hurt >= 0.6) vibe.tone = 'wounded';                                 // worn past rebuff into visible hurt
      return Object.freeze(vibe);                            // strategy reads, never writes
    }

    // perceive a turn across the whole society (the user spoke / a character spoke / a member spoke)
    function perceive(turn) {
      if (!turn || turn.text == null) return null;
      var reactions = [];
      deliberatorMinds().forEach(function (m) { m.perceive(turn); reactions.push(m.react(turn)); });   // specialists don't feel
      state.turns++;
      if (turn.role === 'user') {
        state.lastUserText = turn.text; state.lastUserValence = (turn.valence != null) ? turn.valence : null;
        var hr = read(turn.text);                                                              // hostility aimed AT her builds; warmth mends it, a neutral turn lets it cool
        if (hr.anger >= 1 && hr.warmth < 1) state.hurtStreak = Math.min(12, state.hurtStreak + 1);
        else if (hr.warmth >= 1 || (turn.valence != null && turn.valence > 0.2)) state.hurtStreak = Math.max(0, state.hurtStreak - 3);
        else state.hurtStreak = Math.max(0, state.hurtStreak - 1);
        var nowSent = societySentiment();                                                   // her felt shift in the relationship's tenor
        var prevS = (state.prevSentiment != null) ? state.prevSentiment : nowSent;
        state.affectShift = { up: Math.max(0, nowSent - prevS), down: Math.max(0, prevS - nowSent) };
        state.prevSentiment = nowSent;
      }
      return { cues: read(turn.text), sentiment: societySentiment(), reactions: reactions };
    }

    // PURELY decide who speaks and with what intent - no model call. Each live mind proposes an intent; the
    // society cross-votes (bond + mood + weight + weak noise); the Brain sub-system resolves a winner.
    function deliberateIntents(ctx, opts) {
      ctx = ctx || {}; opts = opts || {};
      var vibe = appraise();                                 // PASS 1 - appraisal (fixed core; one shared frozen vibe)
      var live = route(vibe, ctx);                          // routing: core (always) + top-K by relevance (DESIGN-routing-layer.md)
      var factualAsk = (cfg.factualLane !== false) && !opts.promote && isFactualAsk(state.lastUserText) && vibe.tension < 0.25 && vibe.vulnerability < 0.25 && (vibe.hurt || 0) < 0.2;
      if (factualAsk) { live = live.filter(function (m) { return m.self.id === 'reason' || isCore(m.self.id); }); live = ensureSeated(live, 'reason'); }   // a pure ask: bench the emotional extras, keep the safety cores, seat reason
      if (opts.promote) live = ensureSeated(live, opts.promote);   // /nation <id> --speak: force the addressed node into the room
      if (!live.length) return Promise.resolve({ status: 'no-minds', speaker: null, intent: null, floor: [], vibe: vibe });
      // contributor tier: consult for material first (async, timeout-guarded). Dormant -> resolves {} immediately,
      // so the vote below is unchanged. Material is additive context the deliberators MAY read; it never votes.
      var nom = collectNominations(live, vibe, ctx);          // seated faculties may call in specialists by domain
      var forceIds = nom.ownerIds.slice();
      if (opts.promote && rosterKind(opts.promote) === 'contributor') forceIds.push(opts.promote);
      return consultContributors(vibe, ctx, forceIds).then(function (material) {
        var hasMat = false; for (var k in material) { hasMat = true; break; }
        var vctx = hasMat ? Object.assign({}, ctx, { material: material }) : ctx;
        var proposals = live.map(function (m) { var it = m.intend(vctx, vibe); return { by: it.by, text: it.kind, conf: it.strength, intent: it }; });
        try { if (cfg.settle) settleProposals(proposals, live); } catch (e) {}   // RECURRENCE (off unless the 'settle' toggle): lateral bond-settling before the vote
        var ballots = live.map(function (m) { var sc = {}; proposals.forEach(function (p) { sc[p.by] = jitter(m.voteIntent(p.intent, vctx) * weightOf(p.by, vibe)); }); return { voter: m.self.id, scores: sc }; });
        // each mind may BLOCK a proposal it guards against (conscience/instinct); the Society resolves the vetoes.
        var vetoes = [];
        live.forEach(function (m) { proposals.forEach(function (p) { var v = m.veto && m.veto(p); if (v) vetoes.push(v); }); });
        var decide = (brain && brain.resolve) ? brain.resolve : localResolve;
        var decision = decide(proposals, ballots, vetoes, { vetoQuorum: 1 });
        if (!opts.promote) {                                  // addressing already overrides the vote; never resample over it
          var sampled = sampleWinner(proposals, ballots, decision.vetoed || [], Number(cfg.noise) || 0);
          if (sampled) decision.winnerId = sampled;           // spontaneity may hand the floor to a close runner-up
        }
        // FACTUAL FAST-LANE: reason carries a clear factual/math ask over the emotional cores - unless safety vetoed it.
        if (factualAsk) { var _rp = proposals.filter(function (p) { return p.by === 'reason'; })[0]; if (_rp && (decision.vetoed || []).indexOf('reason') < 0) decision.winnerId = 'reason'; }
        var win = proposals.filter(function (p) { return p.by === decision.winnerId; })[0] || proposals[0];
        decision.speaker = win ? mindOf(win.by).self : null;
        decision.intent = win ? win.intent : null;
        if (opts.promote) applyPromotion(decision, opts.promote, proposals, vetoes, vibe, material);  // addressing overrides the VOTE, never the FLOOR
        // INTENT COMPOSITION (ripple #1): blended top leans. Addressed/factual turns stay single (no blend).
        if (opts.promote) decision.intents = decision.intent ? [{ kind: decision.intent.kind, by: decision.intent.by || decision.winnerId, strength: r2(decision.intent.strength || 0), lead: true }] : [];
        else decision.intents = composeLeans(proposals, ballots, decision, factualAsk);
        decision.floor = proposals.map(function (p) { return { id: p.by, kind: p.intent.kind, strength: r2(p.intent.strength), persona: p.intent.persona && p.intent.persona.name || null }; });
        state.lastRoom = live.map(function (m) { return m.self.id; });                    // for /nation self-report (pure observability)
        state.lastIntents = {}; proposals.forEach(function (p) { state.lastIntents[p.by] = { kind: p.intent.kind, strength: r2(p.intent.strength) }; });
        state.lastWinner = decision.winnerId || state.lastWinner || null;
        decision.vibe = vibe;                                // expose the read (debuggable; the router's input next turn)
        decision.routing = routingTelemetry(vibe, live, selectContributors(vibe, forceIds).map(function (n) { return n.id; }));  // expose WHY the room formed (pure)
        decision.routing.nominations = nom.resolutions;      // which domains were called in, resolved honestly (owned/referred/unknown)
        if (hasMat) decision.material = material;            // expose what was consulted
        return decision;
      });
    }
    // after the chosen line is voiced, every mind reacts to it - the speaker to itself, the rest to a peer
    function reactToSpoken(speakerId, text) {
      var sp = mindOf(speakerId); if (sp && sp.said) sp.said(text);
      state.lastSpeaker = speakerId; state.lastText = text;
      deliberatorMinds().forEach(function (m) { m.react({ who: speakerId, role: m.self.id === speakerId ? 'self' : 'other', text: text }); });
    }
    // fold the user's reaction (like / dislike / kept-talking) back into every mind
    function ingestReaction(sig) {
      sig = sig || {}; var d = (sig.kind === 'up' || sig.kind === 'keep') ? 0.3 : (sig.kind === 'down' ? -0.4 : 0);
      deliberatorMinds().forEach(function (m) { m.user.sentiment = clamp11(m.user.sentiment + d * 0.5); if (sig.toward) m.bonds[sig.toward] = clamp11((m.bonds[sig.toward] || 0) + d); });
    }
    function setUserDescription(desc) { deliberatorMinds().forEach(function (m) { m.user.description = String(desc || ''); }); }
    // a live, human-readable self-report - what it is right now, who spoke, how it reads you, how each mind feels
    function report() {
      var s = societySentiment();
      var lines = ['Right now: ' + (state.lastSpeaker ? (state.lastSpeaker + ' last took the floor') : 'no one has spoken yet') + '; I read you as ' + (s > 0.15 ? 'warming' : (s < -0.15 ? 'struggling' : 'steady')) + '.'];
      minds.filter(function (m) { return isOn(m.self.id); }).forEach(function (m) {
        var d = m.describe();
        if (d.kind === 'contributor') { lines.push('\u2022 ' + d.id + ' \u2014 specialist (' + (d.domain || []).join(', ') + '); supplies material, doesn\u2019t feel or vote'); return; }
        lines.push('\u2022 ' + d.id + (d.persona ? (' (as ' + d.persona + ')') : '') + ' \u2014 mood ' + d.mood + ', reads you ' + d.readsUser + (d.lastSaid ? (', last said \u201c' + String(d.lastSaid).slice(0, 40) + '\u2026\u201d') : ''));
      });
      return lines.join('\n');
    }

    // addressing promotion (DESIGN-specialists-addressing-fringe sec5): force the addressed node into the room, and
    // after the vote make it the speaker - UNLESS a guard vetoed it. Overrides the vote, never the floor.
    function ensureSeated(live, id) {
      if (!isOn(id) || rosterKind(id) !== 'deliberator') return live;   // can't force-seat a disabled node or a contributor
      for (var i = 0; i < live.length; i++) { if (live[i].self.id === id) return live; }
      var m = mindOf(id); return m ? live.concat([m]) : live;
    }
    function applyPromotion(decision, pid, proposals, vetoes, vibe, material) {
      if (rosterKind(pid) === 'contributor') {                       // a contributor speaks by surfacing its MATERIAL, not an intent
        if (!isOn(pid)) { decision.promotion = { requested: pid, granted: false, reason: 'contributor is off' }; return; }
        if (vibe.safety < 0.5) { decision.promotion = { requested: pid, granted: false, reason: 'held by the guard floor (the moment is not safe for a tangent)' }; return; }  // floor for non-intent speakers = the safety read
        decision.winnerId = pid; decision.speaker = mindOf(pid).self;
        decision.intent = { by: pid, kind: 'material', material: (material || {})[pid] != null ? material[pid] : null };
        decision.promotion = { requested: pid, granted: true, as: 'material' };
        decision.status = 'promoted';                                  // the winner was addressed, not voted - don't let status/tally imply agreement
        return;
      }
      var pProp = null;
      for (var i = 0; i < proposals.length; i++) { if (proposals[i].by === pid) { pProp = proposals[i]; break; } }
      if (!pProp) { decision.promotion = { requested: pid, granted: false, reason: 'not an active deliberator (off or unknown)' }; return; }
      var blockers = [];
      vetoes.forEach(function (v) { if (v && v.against === pid) blockers.push(v.by); });
      if (blockers.length) { decision.promotion = { requested: pid, granted: false, reason: 'held by the guard floor', vetoedBy: blockers }; return; }  // floor wins: keep resolve's protective speaker
      decision.winnerId = pid; decision.speaker = mindOf(pid).self; decision.intent = pProp.intent;
      decision.promotion = { requested: pid, granted: true };
      decision.status = 'promoted';                                    // addressed to the floor, not elected by the vote
    }

    // routing telemetry (adopted from the external review): a pure, additive readout of WHY the room formed -
    // who seated (with relevance + effective weight), who was benched, and the contributor standing. Rides on the
    // decision; reading it never changes a decision.
    function routingTelemetry(vibe, live, consultedIds) {
      consultedIds = consultedIds || [];
      var seatedIds = live.map(function (m) { return m.self.id; });
      var delibs = roster.filter(function (n) { return rosterKind(n.id) === 'deliberator'; });
      var seated = [], benched = [];
      delibs.forEach(function (n) {
        if (!isCore(n.id) && !isOn(n.id)) return;                       // config-off non-core: out of play this turn
        var rel = r2(relevanceOf(n.id, vibe));
        if (seatedIds.indexOf(n.id) >= 0) seated.push({ id: n.id, core: isCore(n.id), relevance: rel, weight: r2(weightOf(n.id, vibe)) });
        else benched.push({ id: n.id, relevance: rel });
      });
      var contributors = contributorRecords().filter(function (n) { return isOn(n.id); }).map(function (n) {
        var rel = r2(relevanceOf(n.id, vibe)); return { id: n.id, relevance: rel, consulted: consultedIds.indexOf(n.id) >= 0 };  // ACTUAL (relevance OR nomination/promotion), not just predicted
      });
      return { seatBudget: seatBudget(delibs.length), coreCount: delibs.filter(function (n) { return isCore(n.id); }).length,
        seated: seated, benched: benched, contributors: contributors };
    }

    // ---- /nation addressing & self-report (DESIGN-specialists-addressing-fringe.md sec5,sec7): any node can speak
    //      for itself - its standing in the live moment - and the whole council can be inspected. PURE: reads only
    //      existing state, never touches the decision path, so decisions stay byte-identical when these go unused. ----
    function routeIds(vibe) { return route(vibe, {}).map(function (m) { return m.self.id; }); }
    function standingOf(id, vibe, seated) {
      if (isCore(id)) return 'core';                               // non-maskable: always in the room, even if config 'disables' it (route seats it regardless)
      if (!isOn(id)) return 'off';
      if (rosterKind(id) === 'contributor') return relevanceOf(id, vibe) >= 0.5 ? 'consulted' : 'idle';
      return (seated || routeIds(vibe)).indexOf(id) >= 0 ? 'seated' : 'benched';
    }
    function saysLine(id, rep) {
      var who = id.charAt(0).toUpperCase() + id.slice(1), rel = rep.relevance, stance;
      if (rep.standing === 'core') stance = 'I\u2019m always in the room \u2014 I don\u2019t leave.';
      else if (rep.standing === 'off') stance = 'I\u2019m switched off right now.';
      else if (rep.standing === 'benched') stance = 'this isn\u2019t my moment (' + rel + ') \u2014 I\u2019m sitting it out so the right voice leads.';
      else if (rep.standing === 'seated') stance = (rel >= 0.5)
        ? 'this reads like my moment (' + rel + ') \u2014 I\u2019d take the floor if the vote turns my way.'
        : 'I\u2019m in the room, but this isn\u2019t really my moment (' + rel + ') \u2014 I\u2019ll likely defer to a stronger voice.';
      else if (rep.standing === 'consulted') stance = 'I\u2019m relevant here (' + rel + ') \u2014 ask me and I\u2019ll bring what I know.';
      else stance = 'nothing here is mine (' + rel + ') \u2014 I\u2019d point you elsewhere.';
      return 'I\u2019m ' + who + '. ' + (rep.purpose || '') + ' Right now, ' + stance;
    }
    function selfReport(id, vibe, seated) {
      var n = rosterOf(id);
      if (!n) return { error: 'no such nation: ' + id, known: roster.map(function (r) { return r.id; }) };
      vibe = vibe || appraise();
      var standing = standingOf(id, vibe, seated);
      var li = (state.lastIntents || {})[id] || null;
      var rep = {
        id: id, kind: rosterKind(id), core: isCore(id), purpose: n.purpose,
        domain: n.domain || [], fringe: n.fringe || [],
        relevance: r2(relevanceOf(id, vibe)),
        weight: r2(weightOf(id, vibe)),
        wouldSeat: standing === 'core' || standing === 'seated',
        standing: standing,
        lastIntent: li ? { kind: li.kind, strength: li.strength } : null,
        spokeLast: state.lastWinner === id
      };
      var m = mindOf(id);                                          // a full mind adds its own view; a specialist omits it
      if (m && rep.kind !== 'contributor') { var d = m.describe(); rep.mood = d.mood; rep.reads = d.readsUser; rep.lastSaid = d.lastSaid; }
      rep.says = saysLine(id, rep);
      return rep;
    }
    function inspect(vibe) {
      vibe = vibe || appraise();
      var seated = routeIds(vibe);                                 // computed once, shared across the council
      var council = roster.map(function (n) { return selfReport(n.id, vibe, seated); })
        .sort(function (a, b) { return b.relevance - a.relevance; });
      return { vibe: { tone: vibe.tone, narrative: vibe.narrative, safety: vibe.safety, vulnerability: vibe.vulnerability, tension: vibe.tension, warmth: vibe.warmth }, room: seated, council: council };
    }
    function address(text, vibe) {                                 // the /nation command parser
      var s = String(text || '').trim().replace(/^\/nation\b/, '').trim();
      if (!s) return inspect(vibe);
      var toks = s.split(/\s+/), id = toks[0];
      if (toks.indexOf('--speak') >= 0) return { action: 'promote', id: id };   // hand back to the caller: deliberateIntents(ctx, { promote: id })
      return selfReport(id, vibe);
    }

    return { deliberate: deliberate, about: about, nations: roster, identity: IDENTITY, weightOf: weightOf, isOn: isOn,
      minds: minds, mindOf: mindOf, syncPersonas: syncPersonas, setUserDescription: setUserDescription, report: report,
      selfReport: selfReport, inspect: inspect, address: address, resolveNomination: resolveNomination, findByDomain: findByDomain,
      perceive: perceive, deliberateIntents: deliberateIntents, reactToSpoken: reactToSpoken, ingestReaction: ingestReaction, state: state };
  }

  return { NATIONS: NATIONS, EXTRAS: EXTRAS, createArmy: createArmy, gauge: gauge, modulate: modulate, toneOf: toneOf, feelOf: feelOf, touchOf: touchLookup, MATERIALS: MATERIALS, TOUCH_DIMS: TOUCH_DIMS, sightOf: sightLookup, soundOf: soundLookup, smellOf: smellLookup, tasteOf: tasteLookup, feltOf: feltLookup, FELT_DIMS: FELT_DIMS, calcOf: calcLookup, almanacOf: almanacLookup, isFactualAsk: isFactualAsk, isPersonalAsk: isPersonalAsk, routeOf: routeOf, relDrive: relDrive };
});
