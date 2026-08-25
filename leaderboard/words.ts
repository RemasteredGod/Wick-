/**
 * The assigned-name word list.
 *
 * Committed, versioned, and **append-only** (ADR 0007). Changing an existing
 * entry changes what an already-assigned participant is called; adding to the
 * end does not. Removing one is only safe for a word never yet drawn, which
 * nothing here can tell you — so treat this list as immutable and grow it.
 *
 * Chosen to be neutral: nothing that reads as a rank, a boast, an insult, or a
 * claim about the person. A name nobody minds having is the point, since it is
 * assigned rather than picked and changing it costs a dollar.
 */

export const ADJECTIVES: readonly string[] = [
  'amber', 'ancient', 'autumn', 'bronze', 'calm', 'cedar', 'clay', 'copper',
  'coral', 'crisp', 'dawn', 'dusty', 'ember', 'fallow', 'flint', 'foggy',
  'gentle', 'ginger', 'glass', 'harbour', 'hazel', 'hollow', 'ivory', 'jade',
  'lantern', 'linen', 'marble', 'meadow', 'mellow', 'northern', 'olive', 'paper',
  'pewter', 'quiet', 'rustic', 'saffron', 'sandy', 'silver', 'slate', 'solar',
  'still', 'stone', 'thistle', 'tidal', 'umber', 'velvet', 'wander', 'willow',
];

export const NOUNS: readonly string[] = [
  'anchor', 'atlas', 'beacon', 'bellows', 'birch', 'bramble', 'canyon', 'cascade',
  'cinder', 'compass', 'delta', 'ember', 'fathom', 'ferry', 'forge', 'gable',
  'harbour', 'heron', 'juniper', 'kettle', 'lantern', 'ledger', 'lichen', 'meridian',
  'mortar', 'orchard', 'pebble', 'pilot', 'quarry', 'quill', 'rapids', 'ridge',
  'sable', 'sextant', 'shale', 'signal', 'sparrow', 'summit', 'tangent', 'thicket',
  'timber', 'trellis', 'vellum', 'verge', 'warren', 'willow', 'window', 'yarrow',
];
