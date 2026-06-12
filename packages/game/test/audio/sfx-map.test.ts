/** SFX cue table tests — canonical name = interface (GDD §11.5; PRD 04 US61). */
import { describe, expect, it } from 'vitest';

import { SFX, SFX_M3 } from '../../src/AssetKeys';
import { LAYER_GAIN } from '../../src/audio/audio-director';
import {
  FOOTSTEP_THROTTLE_MS,
  UI_CUES,
  cueForWorldEvent,
  footstepKey,
  routeForKey,
} from '../../src/audio/sfx-map';
import type { SimEvent } from '../../src/sim/types';

describe('cueForWorldEvent', () => {
  const tile = { x: 1, y: 1 };

  it('maps the M1 action events to their M1 keys (unchanged)', () => {
    expect(cueForWorldEvent({ type: 'TileTilled', tile })?.key).toBe(SFX.hoeTill);
    expect(cueForWorldEvent({ type: 'CropPlanted', tile, cropId: 'turnip' })?.key).toBe(
      SFX.seedPlant,
    );
    expect(cueForWorldEvent({ type: 'CropWatered', tiles: [tile] })?.key).toBe(SFX.waterPour);
  });

  it('marks exactly the §6.4 pickup pair as combo-eligible', () => {
    const harvest = cueForWorldEvent({
      type: 'CropHarvested',
      tile,
      cropId: 'turnip',
      count: 1,
      xp: 2,
    });
    const picked = cueForWorldEvent({ type: 'ItemPicked', itemId: 'material_wood', count: 1 });
    expect(harvest?.comboEligible).toBe(true);
    expect(picked?.comboEligible).toBe(true);
    expect(cueForWorldEvent({ type: 'TileTilled', tile })?.comboEligible).toBeUndefined();
  });

  it('routes the five US61 building beats to their canonical keys', () => {
    const cases: [SimEvent, string][] = [
      [{ type: 'StructurePlaced', instanceId: 'i', defId: 'coop', tile }, SFX_M3.buildPlace],
      [{ type: 'SprinklerPlaced', tile, tier: 1 }, SFX_M3.buildPlace],
      [
        { type: 'StructureRemoved', instanceId: 'i', defId: 'fence', refundGold: 10 },
        SFX_M3.buildRefund,
      ],
      [
        { type: 'ConstructionCompleted', instanceId: 'i', defId: 'coop', xp: 150 },
        SFX_M3.buildComplete,
      ],
      [
        { type: 'ProcessingDone', instanceId: 'i', slot: 0, outputItemId: 'artisan_mayonnaise' },
        SFX_M3.processDone,
      ],
    ];
    for (const [event, key] of cases) expect(cueForWorldEvent(event)?.key).toBe(key);
  });

  it('coop egg pickup rides ItemPicked but keeps its canonical egg_collect beat', () => {
    const egg = cueForWorldEvent({ type: 'ItemPicked', itemId: 'animal_egg', count: 4 });
    expect(egg?.key).toBe(SFX_M3.eggCollect);
    expect(egg?.comboEligible).toBe(true);
  });

  it('UI-side events stay out of the world table (no double-play with UIScene)', () => {
    expect(cueForWorldEvent({ type: 'GoldChanged', gold: 100, delta: 50 })).toBeNull();
    expect(cueForWorldEvent({ type: 'FarmLevelUp', level: 2, tilledCap: 18 })).toBeNull();
    expect(
      cueForWorldEvent({ type: 'EggsProduced', instanceId: 'i', count: 4 }), // night production: silent
    ).toBeNull();
  });
});

describe('routeForKey / UI_CUES', () => {
  it('routes UI keys to the ui channel and world keys to the sfx channel', () => {
    expect(routeForKey(SFX_M3.uiClick)).toEqual({ channel: 'ui', layer: 'ui' });
    expect(routeForKey(SFX.uiError)).toEqual({ channel: 'ui', layer: 'ui' });
    expect(routeForKey(SFX.hoeTill)).toEqual({ channel: 'sfx', layer: 'world' });
    expect(routeForKey(SFX_M3.jingleDayEnd)).toEqual({ channel: 'sfx', layer: 'jingle' });
    expect(routeForKey(SFX_M3.blipTalk)).toEqual({ channel: 'ui', layer: 'blip' });
  });

  it('every declared layer exists in LAYER_GAIN', () => {
    for (const cue of Object.values(UI_CUES)) {
      expect(LAYER_GAIN[cue.layer]).toBeGreaterThan(0);
    }
  });

  it('achievement cue graduates to the collect jingle (M3)', () => {
    expect(UI_CUES.achievementUnlocked.key).toBe(SFX_M3.jingleCollect);
  });
});

describe('footsteps', () => {
  it('0.3s throttle constant per §11.5', () => {
    expect(FOOTSTEP_THROTTLE_MS).toBe(300);
  });

  it('variant draw maps [0,1) to the three variants per surface', () => {
    expect(footstepKey('grass', 0)).toBe(SFX_M3.stepGrass0);
    expect(footstepKey('grass', 0.5)).toBe(SFX_M3.stepGrass1);
    expect(footstepKey('grass', 0.99)).toBe(SFX_M3.stepGrass2);
    expect(footstepKey('dirt', 0.4)).toBe(SFX_M3.stepDirt1);
  });
});
