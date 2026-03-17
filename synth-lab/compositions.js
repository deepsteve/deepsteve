// Synth Lab - Compositions
// Three multi-section songs for the step sequencer
//
// Pattern format:
// {
//   name: string,         // Display name
//   bpm: number,          // Tempo in beats per minute
//   steps: number,        // Total 16th-note steps in pattern
//   repeat: number,       // Times to play before advancing (1 = once)
//   tracks: {
//     instrumentId: [
//       { step: number, note?: string, duration?: number, params?: object }
//     ]
//   }
// }
//
// Notes: 'C0'-'B8', default 'C4'. Duration in seconds. Step is 0-indexed 16th note.

// Helper to generate evenly-spaced events
function every(interval, total, base = {}) {
  const events = [];
  for (let i = 0; i < total; i += interval) events.push({ step: i, ...base });
  return events;
}

// ===================================================================
// SONG 1: "DAWN OVER RUINS"
// Key: E minor  |  Tempo: 78-84 BPM
// Theme: Waking up to a broken but beautiful world
// ===================================================================

const DAWN_OVER_RUINS = [
  // --- INTRO: Sparse, lonely. Shimmer and single bells in empty space ---
  {
    name: 'Dawn Over Ruins - Intro', bpm: 82, steps: 128, repeat: 1,
    tracks: {
      shimmer: [
        { step: 0, note: 'E3', duration: 5.0 },
        { step: 32, note: 'B2', duration: 5.0 },
        { step: 64, note: 'C3', duration: 5.0 },
        { step: 96, note: 'D3', duration: 5.0 },
      ],
      fm_bell: [
        { step: 16, note: 'B5', duration: 1.5, params: { ratio: 3.0, modDepth: 1.0, vol: 0.04 } },
        { step: 48, note: 'E5', duration: 1.5, params: { ratio: 2.5, modDepth: 0.8, vol: 0.04 } },
        { step: 80, note: 'G5', duration: 1.5, params: { ratio: 3.0, modDepth: 1.0, vol: 0.05 } },
        { step: 104, note: 'D5', duration: 1.2, params: { ratio: 2.5, vol: 0.05 } },
        { step: 112, note: 'E5', duration: 1.5, params: { ratio: 3.0, vol: 0.06 } },
      ],
      noise_kick: [
        { step: 64, params: { vol: 0.08 } },
        { step: 80, params: { vol: 0.09 } },
        { step: 96, params: { vol: 0.10 } },
        { step: 112, params: { vol: 0.12 } },
      ],
      sub_bass: [
        { step: 96, note: 'D1', duration: 2.0, params: { vol: 0.10 } },
      ],
      soft_lead: [
        { step: 120, note: 'E4', duration: 0.8, params: { vol: 0.06, vibRate: 4, vibDepth: 3 } },
      ],
    }
  },

  // --- BUILD: Drums arrive, bass establishes, strings swell ---
  {
    name: 'Dawn Over Ruins - Build', bpm: 82, steps: 128, repeat: 1,
    tracks: {
      strings: [
        { step: 0, note: 'E3', duration: 4.0, params: { attack: 0.4, bright: 1800 } },
        { step: 32, note: 'G3', duration: 4.0, params: { attack: 0.35, bright: 2000 } },
        { step: 64, note: 'C3', duration: 4.0, params: { attack: 0.3, bright: 2200 } },
        { step: 96, note: 'D3', duration: 4.0, params: { attack: 0.25, bright: 2500 } },
      ],
      sub_bass: [
        { step: 0, note: 'E1', duration: 1.5 },
        { step: 32, note: 'G1', duration: 1.5 },
        { step: 64, note: 'C1', duration: 1.5 },
        { step: 96, note: 'D1', duration: 1.5 },
      ],
      noise_kick: [
        { step: 0 }, { step: 16 }, { step: 32 }, { step: 48 },
        { step: 64 }, { step: 72 }, { step: 80 }, { step: 88 },
        { step: 96 }, { step: 104 }, { step: 108 }, { step: 112 },
        { step: 116 }, { step: 120 }, { step: 124 },
      ],
      noise_hat: [
        { step: 8 }, { step: 24 }, { step: 40 }, { step: 56 },
        { step: 64 },{ step: 68 },{ step: 72 },{ step: 76 },
        { step: 80 },{ step: 84 },{ step: 88 },{ step: 92 },
        { step: 96 },{ step: 98 },{ step: 100 },{ step: 102 },
        { step: 104 },{ step: 106 },{ step: 108 },{ step: 110 },
        { step: 112 },{ step: 114 },{ step: 116 },{ step: 118 },
        { step: 120 },{ step: 122 },{ step: 124 },{ step: 126 },
      ],
      soft_lead: [
        { step: 32, note: 'B4', duration: 0.6, params: { vol: 0.06 } },
        { step: 40, note: 'E5', duration: 0.8, params: { vol: 0.07 } },
        { step: 64, note: 'G5', duration: 0.6, params: { vol: 0.08 } },
        { step: 72, note: 'F#5', duration: 0.5, params: { vol: 0.08 } },
        { step: 80, note: 'E5', duration: 0.9, params: { vol: 0.09, vibRate: 5, vibDepth: 5 } },
        { step: 96, note: 'D5', duration: 0.6, params: { vol: 0.09 } },
        { step: 104, note: 'E5', duration: 0.5, params: { vol: 0.10 } },
        { step: 112, note: 'G5', duration: 0.6, params: { vol: 0.10 } },
        { step: 120, note: 'B5', duration: 0.8, params: { vol: 0.11, vibRate: 6, vibDepth: 6 } },
      ],
      timpani: [
        { step: 96, note: 'E2', duration: 0.5, params: { vol: 0.15 } },
        { step: 112, note: 'D2', duration: 0.5, params: { vol: 0.18 } },
        { step: 124, note: 'E2', duration: 0.4, params: { vol: 0.20 } },
      ],
      fm_bell: [
        { step: 48, note: 'B5', duration: 1.0, params: { vol: 0.04 } },
        { step: 96, note: 'E6', duration: 1.0, params: { vol: 0.04, ratio: 3.5 } },
      ],
    }
  },

  // --- VERSE: Full band, melody sings. Em -> G -> C -> D ---
  {
    name: 'Dawn Over Ruins - Verse', bpm: 82, steps: 128, repeat: 1,
    tracks: {
      soft_lead: [
        { step: 0, note: 'E4', duration: 0.7, params: { vol: 0.11 } },
        { step: 6, note: 'G4', duration: 0.5, params: { vol: 0.10 } },
        { step: 10, note: 'B4', duration: 0.9, params: { vol: 0.12, vibRate: 5, vibDepth: 4 } },
        { step: 20, note: 'A4', duration: 0.5, params: { vol: 0.10 } },
        { step: 24, note: 'G4', duration: 0.7, params: { vol: 0.11 } },
        { step: 32, note: 'B4', duration: 0.7, params: { vol: 0.11 } },
        { step: 38, note: 'D5', duration: 0.5, params: { vol: 0.11 } },
        { step: 42, note: 'E5', duration: 1.0, params: { vol: 0.13, vibRate: 5, vibDepth: 5 } },
        { step: 54, note: 'D5', duration: 0.5, params: { vol: 0.11 } },
        { step: 58, note: 'B4', duration: 0.7, params: { vol: 0.11 } },
        { step: 64, note: 'G4', duration: 0.7, params: { vol: 0.11 } },
        { step: 70, note: 'A4', duration: 0.5, params: { vol: 0.10 } },
        { step: 74, note: 'B4', duration: 0.9, params: { vol: 0.12, vibRate: 5, vibDepth: 4 } },
        { step: 84, note: 'G4', duration: 0.5, params: { vol: 0.10 } },
        { step: 88, note: 'E4', duration: 0.9, params: { vol: 0.12, vibRate: 4, vibDepth: 3 } },
        { step: 96, note: 'D4', duration: 0.6, params: { vol: 0.11 } },
        { step: 102, note: 'E4', duration: 0.5, params: { vol: 0.10 } },
        { step: 106, note: 'G4', duration: 0.7, params: { vol: 0.11 } },
        { step: 114, note: 'F#4', duration: 0.5, params: { vol: 0.10 } },
        { step: 118, note: 'E4', duration: 1.2, params: { vol: 0.12, vibRate: 5, vibDepth: 5 } },
      ],
      strings: [
        { step: 0, note: 'E3', duration: 4.5, params: { attack: 0.3, bright: 2200, vol: 0.05 } },
        { step: 32, note: 'G3', duration: 4.5, params: { attack: 0.3, bright: 2400, vol: 0.05 } },
        { step: 64, note: 'C3', duration: 4.5, params: { attack: 0.3, bright: 2200, vol: 0.05 } },
        { step: 96, note: 'D3', duration: 4.5, params: { attack: 0.3, bright: 2000, vol: 0.05 } },
      ],
      sub_bass: [
        { step: 0, note: 'E1', duration: 1.2 }, { step: 16, note: 'E1', duration: 0.6 },
        { step: 32, note: 'G1', duration: 1.2 }, { step: 48, note: 'G1', duration: 0.6 },
        { step: 64, note: 'C1', duration: 1.2 }, { step: 80, note: 'C1', duration: 0.6 },
        { step: 96, note: 'D1', duration: 1.2 }, { step: 112, note: 'D1', duration: 0.6 },
      ],
      noise_kick: every(16, 128),
      noise_snare: [
        { step: 8 }, { step: 24 }, { step: 40 }, { step: 56 },
        { step: 72 }, { step: 88 }, { step: 104 }, { step: 120 },
      ],
      noise_hat: every(4, 128),
      pluck: [
        { step: 4, note: 'B3', duration: 0.3, params: { cutoff: 3000, vol: 0.06 } },
        { step: 14, note: 'E3', duration: 0.3, params: { cutoff: 2500, vol: 0.05 } },
        { step: 36, note: 'D4', duration: 0.3, params: { cutoff: 3000, vol: 0.06 } },
        { step: 46, note: 'G3', duration: 0.3, params: { cutoff: 2500, vol: 0.05 } },
        { step: 68, note: 'E3', duration: 0.3, params: { cutoff: 3000, vol: 0.06 } },
        { step: 78, note: 'G3', duration: 0.3, params: { cutoff: 2500, vol: 0.05 } },
        { step: 100, note: 'A3', duration: 0.3, params: { cutoff: 3000, vol: 0.06 } },
        { step: 110, note: 'D3', duration: 0.3, params: { cutoff: 2500, vol: 0.05 } },
      ],
      fm_bell: [
        { step: 28, note: 'E6', duration: 0.8, params: { vol: 0.03, ratio: 3.0 } },
        { step: 60, note: 'B5', duration: 0.8, params: { vol: 0.03, ratio: 2.5 } },
        { step: 92, note: 'G5', duration: 0.8, params: { vol: 0.03, ratio: 3.0 } },
        { step: 124, note: 'D6', duration: 0.8, params: { vol: 0.03, ratio: 2.5 } },
      ],
    }
  },

  // --- CHORUS: Everything opens up. Choir enters, brass punctuates ---
  {
    name: 'Dawn Over Ruins - Chorus', bpm: 82, steps: 128, repeat: 1,
    tracks: {
      soft_lead: [
        { step: 0, note: 'B4', duration: 0.9, params: { vol: 0.13, vibRate: 5, vibDepth: 5 } },
        { step: 8, note: 'E5', duration: 0.7, params: { vol: 0.14 } },
        { step: 14, note: 'G5', duration: 1.2, params: { vol: 0.15, vibRate: 6, vibDepth: 6 } },
        { step: 28, note: 'F#5', duration: 0.5, params: { vol: 0.13 } },
        { step: 32, note: 'E5', duration: 0.9, params: { vol: 0.14, vibRate: 5, vibDepth: 5 } },
        { step: 40, note: 'D5', duration: 0.7, params: { vol: 0.13 } },
        { step: 46, note: 'B4', duration: 0.5, params: { vol: 0.12 } },
        { step: 50, note: 'D5', duration: 1.2, params: { vol: 0.14, vibRate: 6, vibDepth: 6 } },
        { step: 64, note: 'E5', duration: 0.9, params: { vol: 0.14, vibRate: 5, vibDepth: 5 } },
        { step: 72, note: 'G5', duration: 0.7, params: { vol: 0.15 } },
        { step: 78, note: 'A5', duration: 1.2, params: { vol: 0.16, vibRate: 6, vibDepth: 7 } },
        { step: 92, note: 'G5', duration: 0.5, params: { vol: 0.14 } },
        { step: 96, note: 'B5', duration: 1.5, params: { vol: 0.16, vibRate: 5, vibDepth: 6 } },
        { step: 112, note: 'A5', duration: 0.6, params: { vol: 0.14 } },
        { step: 118, note: 'G5', duration: 0.5, params: { vol: 0.13 } },
        { step: 122, note: 'E5', duration: 1.0, params: { vol: 0.14, vibRate: 6, vibDepth: 6 } },
      ],
      choir: [
        { step: 0, note: 'E4', duration: 4.5, params: { vol: 0.04, open: 1200 } },
        { step: 32, note: 'C4', duration: 4.5, params: { vol: 0.045, open: 1400 } },
        { step: 64, note: 'G4', duration: 4.5, params: { vol: 0.05, open: 1600 } },
        { step: 96, note: 'D4', duration: 4.5, params: { vol: 0.055, open: 1800 } },
      ],
      strings: [
        { step: 0, note: 'E3', duration: 4.5, params: { attack: 0.2, bright: 2800, vol: 0.06 } },
        { step: 32, note: 'C3', duration: 4.5, params: { attack: 0.2, bright: 3000, vol: 0.06 } },
        { step: 64, note: 'G3', duration: 4.5, params: { attack: 0.15, bright: 3200, vol: 0.07 } },
        { step: 96, note: 'D3', duration: 4.5, params: { attack: 0.15, bright: 3400, vol: 0.07 } },
      ],
      brass: [
        { step: 0, note: 'E4', duration: 0.4, params: { vol: 0.07, bright: 3500 } },
        { step: 32, note: 'C4', duration: 0.4, params: { vol: 0.08, bright: 3800 } },
        { step: 64, note: 'G4', duration: 0.5, params: { vol: 0.09, bright: 4000 } },
        { step: 96, note: 'D4', duration: 0.5, params: { vol: 0.10, bright: 4200 } },
        { step: 96, note: 'D5', duration: 0.3, params: { vol: 0.08, bright: 4500 } },
        { step: 108, note: 'D5', duration: 0.3, params: { vol: 0.09, bright: 4500 } },
      ],
      sub_bass: [
        { step: 0, note: 'E1', duration: 1.5, params: { vol: 0.22 } },
        { step: 32, note: 'C1', duration: 1.5, params: { vol: 0.22 } },
        { step: 64, note: 'G1', duration: 1.5, params: { vol: 0.24 } },
        { step: 96, note: 'D1', duration: 1.5, params: { vol: 0.24 } },
      ],
      noise_kick: [
        { step: 0 }, { step: 8 }, { step: 16 }, { step: 24 },
        { step: 32 }, { step: 40 }, { step: 48 }, { step: 56 },
        { step: 64 }, { step: 72 }, { step: 76 }, { step: 80 }, { step: 88 },
        { step: 96 }, { step: 104 }, { step: 108 }, { step: 112 }, { step: 116 }, { step: 120 },
      ],
      noise_snare: [
        { step: 8 }, { step: 24 }, { step: 40 }, { step: 56 },
        { step: 72 }, { step: 88 }, { step: 104 }, { step: 120 },
      ],
      open_hat: [
        { step: 12, params: { decay: 0.2 } }, { step: 44, params: { decay: 0.2 } },
        { step: 76, params: { decay: 0.25 } }, { step: 108, params: { decay: 0.25 } },
      ],
      noise_hat: every(2, 128),
      timpani: [
        { step: 0, note: 'E2', params: { vol: 0.16 } },
        { step: 32, note: 'C2', params: { vol: 0.16 } },
        { step: 64, note: 'G2', params: { vol: 0.18 } },
        { step: 96, note: 'D2', params: { vol: 0.20 } },
      ],
    }
  },

  // --- BRIDGE: Stripped back, Am. Contemplative piano ---
  {
    name: 'Dawn Over Ruins - Bridge', bpm: 78, steps: 128, repeat: 1,
    tracks: {
      chip_piano: [
        { step: 0, note: 'A4', duration: 0.5 }, { step: 4, note: 'C5', duration: 0.4 },
        { step: 8, note: 'E5', duration: 0.7 },
        { step: 16, note: 'D5', duration: 0.4 }, { step: 20, note: 'C5', duration: 0.5 },
        { step: 24, note: 'A4', duration: 0.7 },
        { step: 32, note: 'G4', duration: 0.5 }, { step: 36, note: 'B4', duration: 0.4 },
        { step: 40, note: 'D5', duration: 0.7 },
        { step: 48, note: 'C5', duration: 0.4 }, { step: 52, note: 'B4', duration: 0.5 },
        { step: 56, note: 'G4', duration: 0.7 },
        { step: 64, note: 'F4', duration: 0.6 },
        { step: 72, note: 'A4', duration: 0.5 },
        { step: 80, note: 'E4', duration: 0.8 },
        { step: 96, note: 'D4', duration: 0.6 },
        { step: 104, note: 'E4', duration: 0.5 },
        { step: 112, note: 'G4', duration: 0.6 },
        { step: 120, note: 'B4', duration: 1.0 },
      ],
      choir: [
        { step: 0, note: 'A3', duration: 5.0, params: { vol: 0.04, open: 1000 } },
        { step: 32, note: 'G3', duration: 5.0, params: { vol: 0.035, open: 900 } },
        { step: 64, note: 'F3', duration: 5.0, params: { vol: 0.03, open: 800 } },
        { step: 96, note: 'D3', duration: 5.0, params: { vol: 0.05, open: 1400 } },
      ],
      shimmer: [
        { step: 64, note: 'F3', duration: 4.0, params: { vol: 0.03 } },
        { step: 96, note: 'D3', duration: 4.0, params: { vol: 0.04 } },
      ],
      sub_bass: [
        { step: 0, note: 'A1', duration: 2.0, params: { vol: 0.12 } },
        { step: 32, note: 'G1', duration: 2.0, params: { vol: 0.10 } },
        { step: 64, note: 'F1', duration: 2.0, params: { vol: 0.08 } },
        { step: 96, note: 'D1', duration: 2.0, params: { vol: 0.15 } },
      ],
      noise_kick: [
        { step: 0, params: { vol: 0.10 } }, { step: 16, params: { vol: 0.08 } },
        { step: 32, params: { vol: 0.10 } }, { step: 48, params: { vol: 0.08 } },
        { step: 96, params: { vol: 0.12 } }, { step: 104 },
        { step: 108 }, { step: 112 }, { step: 116 }, { step: 120 }, { step: 124 },
      ],
      fm_bell: [
        { step: 12, note: 'E6', duration: 1.5, params: { vol: 0.03, ratio: 3.0 } },
        { step: 44, note: 'D6', duration: 1.5, params: { vol: 0.03, ratio: 2.5 } },
        { step: 76, note: 'C6', duration: 1.5, params: { vol: 0.025, ratio: 3.0 } },
        { step: 108, note: 'D6', duration: 1.2, params: { vol: 0.04, ratio: 3.0 } },
      ],
      timpani: [
        { step: 112, note: 'D2', params: { vol: 0.12, sustain: 0.3 } },
        { step: 116, note: 'D2', params: { vol: 0.14, sustain: 0.3 } },
        { step: 120, note: 'D2', params: { vol: 0.16, sustain: 0.3 } },
        { step: 122, note: 'D2', params: { vol: 0.18, sustain: 0.25 } },
        { step: 124, note: 'E2', params: { vol: 0.22, sustain: 0.4 } },
        { step: 126, note: 'E2', params: { vol: 0.25, sustain: 0.5 } },
      ],
      noise_snare: [
        { step: 116, params: { vol: 0.08 } }, { step: 118, params: { vol: 0.09 } },
        { step: 120, params: { vol: 0.10 } }, { step: 122, params: { vol: 0.11 } },
        { step: 124, params: { vol: 0.12 } }, { step: 126, params: { vol: 0.14 } },
      ],
    }
  },

  // --- FINAL CHORUS: Everything at full power ---
  {
    name: 'Dawn Over Ruins - Final', bpm: 84, steps: 128, repeat: 1,
    tracks: {
      soft_lead: [
        { step: 0, note: 'E5', duration: 1.0, params: { vol: 0.16, vibRate: 6, vibDepth: 6 } },
        { step: 10, note: 'G5', duration: 0.7, params: { vol: 0.15 } },
        { step: 16, note: 'A5', duration: 1.3, params: { vol: 0.17, vibRate: 6, vibDepth: 7 } },
        { step: 30, note: 'G5', duration: 0.5, params: { vol: 0.14 } },
        { step: 34, note: 'E5', duration: 1.0, params: { vol: 0.15, vibRate: 5, vibDepth: 5 } },
        { step: 44, note: 'D5', duration: 0.6, params: { vol: 0.14 } },
        { step: 50, note: 'B4', duration: 0.5, params: { vol: 0.13 } },
        { step: 54, note: 'D5', duration: 1.3, params: { vol: 0.16, vibRate: 6, vibDepth: 7 } },
        { step: 64, note: 'E5', duration: 0.8, params: { vol: 0.16, vibRate: 5, vibDepth: 5 } },
        { step: 72, note: 'G5', duration: 0.6, params: { vol: 0.16 } },
        { step: 78, note: 'B5', duration: 1.5, params: { vol: 0.18, vibRate: 6, vibDepth: 8 } },
        { step: 92, note: 'A5', duration: 0.6, params: { vol: 0.15 } },
        { step: 96, note: 'G5', duration: 1.2, params: { vol: 0.16, vibRate: 6, vibDepth: 7 } },
        { step: 108, note: 'E5', duration: 0.7, params: { vol: 0.14 } },
        { step: 114, note: 'D5', duration: 0.6, params: { vol: 0.13 } },
        { step: 120, note: 'E5', duration: 1.5, params: { vol: 0.15, vibRate: 5, vibDepth: 6 } },
      ],
      choir: [
        { step: 0, note: 'E4', duration: 4.5, params: { vol: 0.06, open: 1800 } },
        { step: 32, note: 'C4', duration: 4.5, params: { vol: 0.065, open: 2000 } },
        { step: 64, note: 'G4', duration: 4.5, params: { vol: 0.07, open: 2200 } },
        { step: 96, note: 'D4', duration: 4.5, params: { vol: 0.06, open: 1600 } },
      ],
      strings: [
        { step: 0, note: 'E3', duration: 4.5, params: { attack: 0.15, bright: 3500, vol: 0.07 } },
        { step: 32, note: 'C3', duration: 4.5, params: { attack: 0.15, bright: 3500, vol: 0.07 } },
        { step: 64, note: 'G3', duration: 4.5, params: { attack: 0.1, bright: 4000, vol: 0.08 } },
        { step: 96, note: 'D3', duration: 4.5, params: { attack: 0.2, bright: 2500, vol: 0.06 } },
      ],
      brass: [
        { step: 0, note: 'B4', duration: 0.5, params: { vol: 0.10, bright: 4500 } },
        { step: 32, note: 'G4', duration: 0.5, params: { vol: 0.10, bright: 4500 } },
        { step: 64, note: 'B4', duration: 0.6, params: { vol: 0.12, bright: 5000 } },
        { step: 64, note: 'D5', duration: 0.6, params: { vol: 0.10, bright: 5000 } },
        { step: 96, note: 'A4', duration: 0.4, params: { vol: 0.08, bright: 3500 } },
      ],
      sub_bass: [
        { step: 0, note: 'E1', duration: 1.5, params: { vol: 0.25 } },
        { step: 32, note: 'C1', duration: 1.5, params: { vol: 0.25 } },
        { step: 64, note: 'G1', duration: 1.5, params: { vol: 0.28 } },
        { step: 96, note: 'D1', duration: 2.0, params: { vol: 0.22 } },
      ],
      noise_kick: [
        { step: 0 }, { step: 8 }, { step: 12 }, { step: 16 }, { step: 24 },
        { step: 32 }, { step: 40 }, { step: 44 }, { step: 48 }, { step: 56 },
        { step: 64 }, { step: 72 }, { step: 76 }, { step: 80 }, { step: 84 }, { step: 88 },
        { step: 96 }, { step: 104 }, { step: 112 }, { step: 120 },
      ],
      noise_snare: [
        { step: 8 }, { step: 24 }, { step: 40 }, { step: 56 },
        { step: 72 }, { step: 88 }, { step: 104 }, { step: 120 },
      ],
      noise_hat: every(2, 128),
      open_hat: [
        { step: 12, params: { decay: 0.22 } }, { step: 44, params: { decay: 0.22 } },
        { step: 76, params: { decay: 0.28 } }, { step: 108, params: { decay: 0.2 } },
      ],
      timpani: [
        { step: 0, note: 'E2', params: { vol: 0.20 } },
        { step: 32, note: 'C2', params: { vol: 0.20 } },
        { step: 64, note: 'G2', params: { vol: 0.25 } },
        { step: 96, note: 'D2', params: { vol: 0.18 } },
      ],
      arp_lead: [
        { step: 64, note: 'G4', duration: 0.5, params: { intervals: [0, 4, 7, 12, 16], speed: 0.08, vol: 0.04 } },
        { step: 80, note: 'G4', duration: 0.5, params: { intervals: [0, 7, 12, 19], speed: 0.08, vol: 0.04 } },
      ],
      fm_bell: [
        { step: 78, note: 'B6', duration: 1.5, params: { vol: 0.04, ratio: 3.5, modDepth: 1.5 } },
      ],
    }
  },

  // --- OUTRO: Everything dissolves ---
  {
    name: 'Dawn Over Ruins - Outro', bpm: 78, steps: 128, repeat: 1,
    tracks: {
      soft_lead: [
        { step: 0, note: 'E4', duration: 1.0, params: { vol: 0.12, vibRate: 4, vibDepth: 4 } },
        { step: 12, note: 'G4', duration: 0.8, params: { vol: 0.10 } },
        { step: 20, note: 'B4', duration: 1.5, params: { vol: 0.09, vibRate: 4, vibDepth: 3 } },
        { step: 40, note: 'E4', duration: 1.0, params: { vol: 0.07, vibRate: 3, vibDepth: 2 } },
        { step: 56, note: 'G4', duration: 1.5, params: { vol: 0.05, vibRate: 3, vibDepth: 2 } },
      ],
      strings: [
        { step: 0, note: 'E3', duration: 5.0, params: { attack: 0.3, bright: 2000, vol: 0.05 } },
        { step: 32, note: 'G3', duration: 5.0, params: { attack: 0.4, bright: 1500, vol: 0.04 } },
        { step: 64, note: 'E3', duration: 6.0, params: { attack: 0.5, bright: 1200, vol: 0.03 } },
      ],
      choir: [
        { step: 0, note: 'E4', duration: 5.0, params: { vol: 0.04, open: 1200 } },
        { step: 32, note: 'G3', duration: 5.0, params: { vol: 0.03, open: 1000 } },
        { step: 64, note: 'E3', duration: 6.0, params: { vol: 0.02, open: 800 } },
      ],
      shimmer: [
        { step: 0, note: 'E3', duration: 5.0, params: { vol: 0.04 } },
        { step: 32, note: 'G3', duration: 5.0, params: { vol: 0.035 } },
        { step: 64, note: 'E3', duration: 8.0, params: { vol: 0.03 } },
      ],
      fm_bell: [
        { step: 16, note: 'B5', duration: 2.0, params: { vol: 0.04, ratio: 3.0, modDepth: 0.8 } },
        { step: 48, note: 'E5', duration: 2.0, params: { vol: 0.035, ratio: 2.5, modDepth: 0.6 } },
        { step: 80, note: 'B5', duration: 2.5, params: { vol: 0.03, ratio: 3.0, modDepth: 0.5 } },
        { step: 112, note: 'E5', duration: 3.0, params: { vol: 0.02, ratio: 2.5, modDepth: 0.4 } },
      ],
      sub_bass: [
        { step: 0, note: 'E1', duration: 2.0, params: { vol: 0.15 } },
        { step: 32, note: 'G1', duration: 2.0, params: { vol: 0.10 } },
        { step: 64, note: 'E1', duration: 3.0, params: { vol: 0.06 } },
      ],
      noise_kick: [
        { step: 0, params: { vol: 0.12 } }, { step: 16, params: { vol: 0.10 } },
        { step: 32, params: { vol: 0.08 } }, { step: 48, params: { vol: 0.06 } },
      ],
      noise_hat: [
        { step: 0, params: { vol: 0.04 } }, { step: 8, params: { vol: 0.035 } },
        { step: 16, params: { vol: 0.03 } }, { step: 24, params: { vol: 0.025 } },
        { step: 32, params: { vol: 0.02 } },
      ],
      pluck: [
        { step: 96, note: 'B4', duration: 0.5, params: { cutoff: 2000, vol: 0.03 } },
        { step: 108, note: 'E4', duration: 0.5, params: { cutoff: 1500, vol: 0.02 } },
      ],
    }
  },
];


// ===================================================================
// SONG 2: "OCEAN OF CIRCUITS"
// Key: D minor -> D major  |  Tempo: 76-118 BPM
// Theme: Journey through a digital sea
// ===================================================================

const OCEAN_OF_CIRCUITS = [
  // --- PULSE: Deep, pulsing bass and ticking hats ---
  {
    name: 'Ocean of Circuits - Pulse', bpm: 100, steps: 128, repeat: 1,
    tracks: {
      wobble_bass: [
        { step: 0, note: 'D2', duration: 0.8, params: { rate: 2, depth: 400, center: 600, vol: 0.12 } },
        { step: 16, note: 'D2', duration: 0.6, params: { rate: 2.5, depth: 450, center: 650, vol: 0.12 } },
        { step: 32, note: 'F2', duration: 0.8, params: { rate: 2, depth: 400, center: 600, vol: 0.13 } },
        { step: 48, note: 'F2', duration: 0.6, params: { rate: 3, depth: 500, center: 700, vol: 0.13 } },
        { step: 64, note: 'A2', duration: 0.8, params: { rate: 2, depth: 400, center: 600, vol: 0.14 } },
        { step: 80, note: 'G2', duration: 0.6, params: { rate: 3, depth: 500, center: 700, vol: 0.14 } },
        { step: 96, note: 'D2', duration: 0.8, params: { rate: 2, depth: 400, center: 600, vol: 0.15 } },
        { step: 112, note: 'D2', duration: 0.8, params: { rate: 4, depth: 600, center: 800, vol: 0.16 } },
      ],
      noise_hat: (function() { var h = []; for (var i = 0; i < 128; i += 4) h.push({ step: i, params: { vol: 0.03 + (i/128) * 0.03 } }); return h; })(),
      noise_kick: (function() { var k = []; for (var i = 32; i < 128; i += 8) k.push({ step: i, params: { vol: 0.08 + ((i-32)/96) * 0.12 } }); return k; })(),
      arp_lead: [
        { step: 48, note: 'D4', duration: 0.5, params: { intervals: [0, 3, 7], speed: 0.1, vol: 0.03 } },
        { step: 80, note: 'F4', duration: 0.5, params: { intervals: [0, 4, 7], speed: 0.1, vol: 0.035 } },
        { step: 112, note: 'A4', duration: 0.5, params: { intervals: [0, 3, 7, 12], speed: 0.08, vol: 0.04 } },
      ],
      shimmer: [
        { step: 0, note: 'D2', duration: 6.0, params: { vol: 0.02 } },
        { step: 64, note: 'D2', duration: 6.0, params: { vol: 0.03 } },
      ],
    }
  },

  // --- RISE: Energy builds, melody enters. Dm -> Bb -> F -> C ---
  {
    name: 'Ocean of Circuits - Rise', bpm: 104, steps: 128, repeat: 1,
    tracks: {
      noise_kick: (function() { var k = []; for (var i = 0; i < 128; i += 8) k.push({ step: i }); for (var i = 68; i < 128; i += 8) k.push({ step: i + 4 }); return k; })(),
      noise_snare: (function() { var s = []; for (var i = 8; i < 128; i += 16) s.push({ step: i }); return s; })(),
      noise_hat: every(2, 128),
      open_hat: [
        { step: 12, params: { decay: 0.2 } }, { step: 44, params: { decay: 0.2 } },
        { step: 76, params: { decay: 0.25 } }, { step: 108, params: { decay: 0.25 } },
      ],
      pulse_bass: [
        { step: 0, note: 'D2', duration: 0.25 }, { step: 4, note: 'D2', duration: 0.15 },
        { step: 6, note: 'D2', duration: 0.15 },
        { step: 16, note: 'D2', duration: 0.25 }, { step: 20, note: 'D2', duration: 0.15 },
        { step: 32, note: 'A#1', duration: 0.25 }, { step: 36, note: 'A#1', duration: 0.15 },
        { step: 38, note: 'A#1', duration: 0.15 },
        { step: 48, note: 'A#1', duration: 0.25 }, { step: 52, note: 'A#1', duration: 0.15 },
        { step: 64, note: 'F2', duration: 0.25 }, { step: 68, note: 'F2', duration: 0.15 },
        { step: 70, note: 'F2', duration: 0.15 },
        { step: 80, note: 'F2', duration: 0.25 }, { step: 84, note: 'F2', duration: 0.15 },
        { step: 96, note: 'C2', duration: 0.25 }, { step: 100, note: 'C2', duration: 0.15 },
        { step: 102, note: 'C2', duration: 0.15 },
        { step: 112, note: 'C2', duration: 0.25 }, { step: 116, note: 'C2', duration: 0.15 },
      ],
      chip_lead: [
        { step: 0, note: 'D4', duration: 0.2 }, { step: 3, note: 'F4', duration: 0.15 },
        { step: 6, note: 'A4', duration: 0.3, params: { vibrato: { rate: 6, depth: 4 } } },
        { step: 12, note: 'G4', duration: 0.2 }, { step: 16, note: 'F4', duration: 0.3 },
        { step: 22, note: 'D4', duration: 0.2 },
        { step: 32, note: 'D4', duration: 0.2 }, { step: 35, note: 'F4', duration: 0.15 },
        { step: 38, note: 'A#4', duration: 0.3, params: { vibrato: { rate: 6, depth: 4 } } },
        { step: 44, note: 'A4', duration: 0.2 }, { step: 48, note: 'G4', duration: 0.3 },
        { step: 64, note: 'F4', duration: 0.2 }, { step: 67, note: 'A4', duration: 0.15 },
        { step: 70, note: 'C5', duration: 0.3, params: { vibrato: { rate: 7, depth: 5 } } },
        { step: 76, note: 'A#4', duration: 0.2 }, { step: 80, note: 'A4', duration: 0.3 },
        { step: 96, note: 'G4', duration: 0.2 }, { step: 99, note: 'A#4', duration: 0.15 },
        { step: 102, note: 'D5', duration: 0.4, params: { vibrato: { rate: 7, depth: 6 } } },
        { step: 110, note: 'C5', duration: 0.2 }, { step: 114, note: 'A#4', duration: 0.2 },
        { step: 118, note: 'A4', duration: 0.15 },
        { step: 122, note: 'D5', duration: 0.5, params: { vibrato: { rate: 8, depth: 7 } } },
      ],
      strings: [
        { step: 64, note: 'F3', duration: 4.0, params: { attack: 0.3, bright: 2500, vol: 0.04 } },
        { step: 96, note: 'C3', duration: 4.0, params: { attack: 0.2, bright: 3000, vol: 0.05 } },
      ],
      tri_pad: [
        { step: 0, note: 'D3', duration: 2.0, params: { vol: 0.06 } },
        { step: 32, note: 'A#2', duration: 2.0, params: { vol: 0.06 } },
        { step: 64, note: 'F3', duration: 2.0, params: { vol: 0.06 } },
        { step: 96, note: 'C3', duration: 2.0, params: { vol: 0.06 } },
      ],
    }
  },

  // --- STORM: Intense, chaotic energy ---
  {
    name: 'Ocean of Circuits - Storm', bpm: 118, steps: 128, repeat: 1,
    tracks: {
      noise_kick: every(4, 128, { params: { vol: 0.28 } }),
      noise_snare: (function() {
        var s = []; for (var i = 4; i < 128; i += 8) s.push({ step: i, params: { vol: 0.14 } });
        for (var i = 10; i < 128; i += 16) s.push({ step: i, params: { vol: 0.06 } }); return s;
      })(),
      noise_hat: (function() {
        var h = []; for (var i = 0; i < 128; i += 2) h.push({ step: i, params: { vol: 0.05 } });
        for (var i = 48; i < 64; i++) h.push({ step: i, params: { vol: 0.04 } });
        for (var i = 112; i < 128; i++) h.push({ step: i, params: { vol: 0.04 } }); return h;
      })(),
      wobble_bass: [
        { step: 0, note: 'D2', duration: 0.6, params: { rate: 6, depth: 800, center: 900, q: 10, vol: 0.16 } },
        { step: 8, note: 'D2', duration: 0.4, params: { rate: 8, depth: 900, center: 1000, q: 12, vol: 0.16 } },
        { step: 16, note: 'F2', duration: 0.6, params: { rate: 6, depth: 800, center: 900, q: 10, vol: 0.16 } },
        { step: 24, note: 'F2', duration: 0.4, params: { rate: 8, depth: 900, center: 1000, q: 12, vol: 0.16 } },
        { step: 32, note: 'A#1', duration: 0.6, params: { rate: 6, depth: 800, q: 10, vol: 0.17 } },
        { step: 40, note: 'A#1', duration: 0.4, params: { rate: 8, depth: 900, q: 12, vol: 0.17 } },
        { step: 48, note: 'C2', duration: 0.6, params: { rate: 6, depth: 800, q: 10, vol: 0.17 } },
        { step: 56, note: 'C2', duration: 0.4, params: { rate: 8, depth: 900, q: 12, vol: 0.17 } },
        { step: 64, note: 'D2', duration: 0.6, params: { rate: 7, depth: 900, center: 1000, q: 12, vol: 0.18 } },
        { step: 72, note: 'D2', duration: 0.4, params: { rate: 9, depth: 1000, center: 1100, q: 14, vol: 0.18 } },
        { step: 80, note: 'F2', duration: 0.6, params: { rate: 7, depth: 900, q: 12, vol: 0.18 } },
        { step: 88, note: 'F2', duration: 0.4, params: { rate: 9, depth: 1000, q: 14, vol: 0.18 } },
        { step: 96, note: 'A#1', duration: 0.8, params: { rate: 5, depth: 700, q: 8, vol: 0.19 } },
        { step: 112, note: 'C2', duration: 0.8, params: { rate: 5, depth: 700, q: 8, vol: 0.19 } },
      ],
      chip_lead: [
        { step: 0, note: 'D5', duration: 0.1 }, { step: 2, note: 'F5', duration: 0.1 },
        { step: 4, note: 'A5', duration: 0.15, params: { vibrato: { rate: 10, depth: 8 } } },
        { step: 8, note: 'G5', duration: 0.1 }, { step: 10, note: 'F5', duration: 0.15 },
        { step: 16, note: 'A5', duration: 0.1 }, { step: 18, note: 'C6', duration: 0.1 },
        { step: 20, note: 'D6', duration: 0.2, params: { vibrato: { rate: 10, depth: 10 } } },
        { step: 24, note: 'C6', duration: 0.1 }, { step: 26, note: 'A5', duration: 0.15 },
        { step: 32, note: 'A#5', duration: 0.1 }, { step: 34, note: 'D6', duration: 0.1 },
        { step: 36, note: 'F6', duration: 0.2, params: { vibrato: { rate: 10, depth: 10 } } },
        { step: 40, note: 'D6', duration: 0.1 }, { step: 42, note: 'A#5', duration: 0.15 },
        { step: 48, note: 'C6', duration: 0.1 }, { step: 50, note: 'E6', duration: 0.1 },
        { step: 52, note: 'G6', duration: 0.25, params: { vibrato: { rate: 12, depth: 12 } } },
        { step: 64, note: 'F6', duration: 0.15 }, { step: 66, note: 'D6', duration: 0.15 },
        { step: 68, note: 'A5', duration: 0.2, params: { vibrato: { rate: 8, depth: 6 } } },
        { step: 76, note: 'G5', duration: 0.15 }, { step: 78, note: 'F5', duration: 0.2 },
        { step: 84, note: 'D5', duration: 0.15 }, { step: 86, note: 'C5', duration: 0.2 },
        { step: 92, note: 'A4', duration: 0.3, params: { vibrato: { rate: 6, depth: 5 } } },
        { step: 104, note: 'D5', duration: 0.1 }, { step: 106, note: 'F5', duration: 0.1 },
        { step: 108, note: 'A5', duration: 0.1 }, { step: 110, note: 'D6', duration: 0.1 },
        { step: 112, note: 'F6', duration: 0.1 }, { step: 114, note: 'A6', duration: 0.15 },
        { step: 120, note: 'D5', duration: 0.5, params: { vibrato: { rate: 6, depth: 8 } } },
      ],
      brass: [
        { step: 0, note: 'D4', duration: 0.3, params: { vol: 0.09, bright: 4500 } },
        { step: 32, note: 'A#3', duration: 0.3, params: { vol: 0.09, bright: 4500 } },
        { step: 64, note: 'D4', duration: 0.4, params: { vol: 0.10, bright: 5000 } },
        { step: 64, note: 'F4', duration: 0.4, params: { vol: 0.08, bright: 5000 } },
        { step: 96, note: 'A#3', duration: 0.5, params: { vol: 0.11, bright: 5000 } },
        { step: 96, note: 'D4', duration: 0.5, params: { vol: 0.09, bright: 5000 } },
      ],
      strings: [
        { step: 0, note: 'D3', duration: 3.0, params: { attack: 0.1, bright: 3500, vol: 0.06 } },
        { step: 32, note: 'A#2', duration: 3.0, params: { attack: 0.1, bright: 3500, vol: 0.06 } },
        { step: 64, note: 'D3', duration: 3.0, params: { attack: 0.08, bright: 4000, vol: 0.07 } },
        { step: 96, note: 'A#2', duration: 3.0, params: { attack: 0.08, bright: 4000, vol: 0.07 } },
      ],
      timpani: [
        { step: 0, note: 'D2', params: { vol: 0.22 } },
        { step: 32, note: 'A#1', params: { vol: 0.22 } },
        { step: 64, note: 'D2', params: { vol: 0.25 } },
        { step: 96, note: 'A#1', params: { vol: 0.25 } },
        { step: 120, note: 'D2', params: { vol: 0.18, sustain: 0.2 } },
        { step: 122, note: 'D2', params: { vol: 0.20, sustain: 0.2 } },
        { step: 124, note: 'D2', params: { vol: 0.22, sustain: 0.2 } },
        { step: 126, note: 'D2', params: { vol: 0.28, sustain: 0.4 } },
      ],
    }
  },

  // --- CALM: After the storm. Bells and soft melody ---
  {
    name: 'Ocean of Circuits - Calm', bpm: 76, steps: 128, repeat: 1,
    tracks: {
      fm_bell: [
        { step: 0, note: 'D5', duration: 1.5, params: { ratio: 2.5, modDepth: 0.6, vol: 0.05 } },
        { step: 12, note: 'A5', duration: 1.2, params: { ratio: 3.0, modDepth: 0.5, vol: 0.04 } },
        { step: 24, note: 'F5', duration: 1.0, params: { ratio: 2.0, modDepth: 0.8, vol: 0.04 } },
        { step: 40, note: 'G5', duration: 1.5, params: { ratio: 2.5, modDepth: 0.6, vol: 0.045 } },
        { step: 52, note: 'D6', duration: 1.2, params: { ratio: 3.0, modDepth: 0.5, vol: 0.04 } },
        { step: 64, note: 'C5', duration: 1.5, params: { ratio: 2.5, modDepth: 0.6, vol: 0.05 } },
        { step: 76, note: 'A5', duration: 1.0, params: { ratio: 2.0, modDepth: 0.7, vol: 0.04 } },
        { step: 88, note: 'F5', duration: 1.5, params: { ratio: 3.0, modDepth: 0.5, vol: 0.045 } },
        { step: 100, note: 'D5', duration: 1.5, params: { ratio: 2.5, modDepth: 0.6, vol: 0.05 } },
        { step: 116, note: 'A5', duration: 2.0, params: { ratio: 3.0, modDepth: 0.4, vol: 0.04 } },
      ],
      soft_lead: [
        { step: 32, note: 'D4', duration: 1.0, params: { vol: 0.07, vibRate: 3, vibDepth: 2 } },
        { step: 44, note: 'F4', duration: 0.8, params: { vol: 0.07 } },
        { step: 52, note: 'A4', duration: 1.2, params: { vol: 0.08, vibRate: 4, vibDepth: 3 } },
        { step: 68, note: 'G4', duration: 0.8, params: { vol: 0.07 } },
        { step: 76, note: 'F4', duration: 1.0, params: { vol: 0.08, vibRate: 4, vibDepth: 3 } },
        { step: 92, note: 'D4', duration: 1.5, params: { vol: 0.09, vibRate: 4, vibDepth: 4 } },
        { step: 108, note: 'F4', duration: 0.6, params: { vol: 0.10 } },
        { step: 116, note: 'A4', duration: 0.6, params: { vol: 0.11 } },
        { step: 122, note: 'D5', duration: 0.8, params: { vol: 0.12, vibRate: 5, vibDepth: 5 } },
      ],
      shimmer: [
        { step: 0, note: 'D3', duration: 6.0, params: { vol: 0.04 } },
        { step: 64, note: 'F3', duration: 6.0, params: { vol: 0.04 } },
      ],
      choir: [{ step: 64, note: 'D3', duration: 6.0, params: { vol: 0.025, open: 800 } }],
      sub_bass: [
        { step: 0, note: 'D1', duration: 3.0, params: { vol: 0.08 } },
        { step: 64, note: 'F1', duration: 3.0, params: { vol: 0.10 } },
      ],
      noise_kick: [
        { step: 64, params: { vol: 0.06 } }, { step: 96, params: { vol: 0.08 } },
        { step: 112, params: { vol: 0.10 } }, { step: 120, params: { vol: 0.12 } },
      ],
      strings: [{ step: 96, note: 'D3', duration: 4.0, params: { attack: 0.5, bright: 1800, vol: 0.04 } }],
    }
  },

  // --- RESURFACE: Triumphant return, D minor to D MAJOR ---
  {
    name: 'Ocean of Circuits - Resurface', bpm: 108, steps: 128, repeat: 1,
    tracks: {
      soft_lead: [
        { step: 0, note: 'D5', duration: 1.0, params: { vol: 0.14, vibRate: 5, vibDepth: 5 } },
        { step: 10, note: 'F#5', duration: 0.7, params: { vol: 0.14 } },
        { step: 16, note: 'A5', duration: 1.2, params: { vol: 0.16, vibRate: 6, vibDepth: 6 } },
        { step: 28, note: 'G5', duration: 0.5, params: { vol: 0.14 } },
        { step: 32, note: 'F#5', duration: 1.0, params: { vol: 0.15, vibRate: 5, vibDepth: 5 } },
        { step: 42, note: 'E5', duration: 0.6, params: { vol: 0.14 } },
        { step: 48, note: 'D5', duration: 1.2, params: { vol: 0.15, vibRate: 6, vibDepth: 6 } },
        { step: 64, note: 'A5', duration: 1.0, params: { vol: 0.16, vibRate: 6, vibDepth: 6 } },
        { step: 74, note: 'B5', duration: 0.7, params: { vol: 0.16 } },
        { step: 80, note: 'D6', duration: 1.5, params: { vol: 0.18, vibRate: 6, vibDepth: 8 } },
        { step: 94, note: 'A5', duration: 0.6, params: { vol: 0.15 } },
        { step: 100, note: 'F#5', duration: 1.0, params: { vol: 0.16, vibRate: 5, vibDepth: 6 } },
        { step: 112, note: 'D5', duration: 2.0, params: { vol: 0.15, vibRate: 5, vibDepth: 5 } },
      ],
      choir: [
        { step: 0, note: 'D4', duration: 4.0, params: { vol: 0.05, open: 1600 } },
        { step: 32, note: 'A3', duration: 4.0, params: { vol: 0.055, open: 1800 } },
        { step: 64, note: 'G4', duration: 4.0, params: { vol: 0.06, open: 2000 } },
        { step: 96, note: 'D4', duration: 4.0, params: { vol: 0.055, open: 1400 } },
      ],
      strings: [
        { step: 0, note: 'D3', duration: 4.0, params: { attack: 0.15, bright: 3200, vol: 0.06 } },
        { step: 32, note: 'A3', duration: 4.0, params: { attack: 0.15, bright: 3200, vol: 0.06 } },
        { step: 64, note: 'G3', duration: 4.0, params: { attack: 0.1, bright: 3800, vol: 0.07 } },
        { step: 96, note: 'D3', duration: 5.0, params: { attack: 0.2, bright: 2500, vol: 0.05 } },
      ],
      brass: [
        { step: 0, note: 'D4', duration: 0.5, params: { vol: 0.09, bright: 4000 } },
        { step: 0, note: 'F#4', duration: 0.5, params: { vol: 0.07, bright: 4000 } },
        { step: 32, note: 'A4', duration: 0.4, params: { vol: 0.08, bright: 4000 } },
        { step: 64, note: 'G4', duration: 0.5, params: { vol: 0.10, bright: 4500 } },
        { step: 64, note: 'B4', duration: 0.5, params: { vol: 0.08, bright: 4500 } },
        { step: 96, note: 'D4', duration: 0.4, params: { vol: 0.07, bright: 3500 } },
      ],
      sub_bass: [
        { step: 0, note: 'D1', duration: 1.5, params: { vol: 0.22 } },
        { step: 32, note: 'A1', duration: 1.5, params: { vol: 0.22 } },
        { step: 64, note: 'G1', duration: 1.5, params: { vol: 0.24 } },
        { step: 96, note: 'D1', duration: 2.0, params: { vol: 0.20 } },
      ],
      noise_kick: (function() { var k = []; for (var i = 0; i < 96; i += 8) k.push({ step: i }); k.push({ step: 96 }); k.push({ step: 112 }); return k; })(),
      noise_snare: (function() { var s = []; for (var i = 8; i < 96; i += 16) s.push({ step: i }); return s; })(),
      noise_hat: (function() { var h = []; for (var i = 0; i < 96; i += 4) h.push({ step: i }); return h; })(),
      timpani: [
        { step: 0, note: 'D2', params: { vol: 0.18 } },
        { step: 32, note: 'A2', params: { vol: 0.18 } },
        { step: 64, note: 'G2', params: { vol: 0.22 } },
      ],
      shimmer: [{ step: 96, note: 'D3', duration: 5.0, params: { vol: 0.04 } }],
      fm_bell: [
        { step: 80, note: 'D7', duration: 2.0, params: { ratio: 3.5, modDepth: 1.0, vol: 0.03 } },
        { step: 112, note: 'D6', duration: 3.0, params: { ratio: 2.5, modDepth: 0.5, vol: 0.03 } },
      ],
    }
  },
];


// ===================================================================
// SONG 3: "LETTERS NEVER SENT"
// Key: G minor -> Bb major  |  Tempo: 68-78 BPM
// Theme: Loss, things left unsaid, acceptance
// ===================================================================

const LETTERS_NEVER_SENT = [
  // --- HEARTBEAT: Just a pulse and distant bells ---
  {
    name: 'Letters Never Sent - Heartbeat', bpm: 72, steps: 128, repeat: 1,
    tracks: {
      heartbeat: [
        { step: 0, params: { vol: 0.12, gap: 0.2 } },
        { step: 16, params: { vol: 0.13, gap: 0.2 } },
        { step: 32, params: { vol: 0.14, gap: 0.2 } },
        { step: 48, params: { vol: 0.15, gap: 0.2 } },
        { step: 64, params: { vol: 0.16, gap: 0.2 } },
        { step: 80, params: { vol: 0.16, gap: 0.2 } },
        { step: 96, params: { vol: 0.15, gap: 0.2 } },
        { step: 112, params: { vol: 0.14, gap: 0.2 } },
      ],
      fm_bell: [
        { step: 24, note: 'D6', duration: 2.5, params: { ratio: 3.0, modDepth: 0.4, vol: 0.025 } },
        { step: 56, note: 'G5', duration: 2.0, params: { ratio: 2.5, modDepth: 0.5, vol: 0.03 } },
        { step: 88, note: 'A#5', duration: 2.0, params: { ratio: 3.0, modDepth: 0.4, vol: 0.03 } },
        { step: 116, note: 'A5', duration: 2.5, params: { ratio: 2.5, modDepth: 0.3, vol: 0.035 } },
      ],
      shimmer: [{ step: 64, note: 'G2', duration: 8.0, params: { vol: 0.02 } }],
      marimba: [
        { step: 40, note: 'G4', duration: 0.6, params: { vol: 0.04 } },
        { step: 72, note: 'D5', duration: 0.5, params: { vol: 0.05 } },
        { step: 104, note: 'A#4', duration: 0.5, params: { vol: 0.05 } },
      ],
    }
  },

  // --- MEMORY: Delay lead melody, marimba music box pattern ---
  {
    name: 'Letters Never Sent - Memory', bpm: 76, steps: 128, repeat: 1,
    tracks: {
      delay_lead: [
        { step: 0, note: 'G4', duration: 0.8, params: { echoes: 3, spacing: 0.2, decay: 0.5, vol: 0.08 } },
        { step: 16, note: 'A#4', duration: 0.6, params: { echoes: 2, spacing: 0.18, decay: 0.5, vol: 0.08 } },
        { step: 24, note: 'D5', duration: 1.0, params: { echoes: 4, spacing: 0.22, decay: 0.5, vol: 0.09 } },
        { step: 40, note: 'C5', duration: 0.6, params: { echoes: 2, spacing: 0.18, decay: 0.5, vol: 0.08 } },
        { step: 48, note: 'A#4', duration: 1.0, params: { echoes: 3, spacing: 0.2, decay: 0.5, vol: 0.09 } },
        { step: 64, note: 'D5', duration: 0.8, params: { echoes: 3, spacing: 0.2, decay: 0.5, vol: 0.09 } },
        { step: 76, note: 'F5', duration: 0.6, params: { echoes: 2, spacing: 0.18, decay: 0.5, vol: 0.09 } },
        { step: 84, note: 'G5', duration: 1.2, params: { echoes: 4, spacing: 0.25, decay: 0.45, vol: 0.10 } },
        { step: 100, note: 'F5', duration: 0.6, params: { echoes: 2, spacing: 0.18, decay: 0.5, vol: 0.09 } },
        { step: 108, note: 'D5', duration: 1.0, params: { echoes: 3, spacing: 0.22, decay: 0.5, vol: 0.10 } },
        { step: 120, note: 'G4', duration: 1.5, params: { echoes: 4, spacing: 0.25, decay: 0.45, vol: 0.10 } },
      ],
      marimba: [
        { step: 0, note: 'G3', duration: 0.4 }, { step: 4, note: 'D4', duration: 0.3 },
        { step: 8, note: 'A#3', duration: 0.4 }, { step: 12, note: 'D4', duration: 0.3 },
        { step: 16, note: 'G3', duration: 0.4 }, { step: 20, note: 'D4', duration: 0.3 },
        { step: 24, note: 'A#3', duration: 0.4 }, { step: 28, note: 'F4', duration: 0.3 },
        { step: 32, note: 'G3', duration: 0.4 }, { step: 36, note: 'D4', duration: 0.3 },
        { step: 40, note: 'A#3', duration: 0.4 }, { step: 44, note: 'D4', duration: 0.3 },
        { step: 48, note: 'F3', duration: 0.4 }, { step: 52, note: 'C4', duration: 0.3 },
        { step: 56, note: 'A3', duration: 0.4 }, { step: 60, note: 'C4', duration: 0.3 },
        { step: 64, note: 'G3', duration: 0.4 }, { step: 68, note: 'D4', duration: 0.3 },
        { step: 72, note: 'A#3', duration: 0.4 }, { step: 76, note: 'D4', duration: 0.3 },
        { step: 80, note: 'G3', duration: 0.4 }, { step: 84, note: 'D4', duration: 0.3 },
        { step: 88, note: 'A#3', duration: 0.4 }, { step: 92, note: 'F4', duration: 0.3 },
        { step: 96, note: 'F3', duration: 0.4 }, { step: 100, note: 'C4', duration: 0.3 },
        { step: 104, note: 'A3', duration: 0.4 }, { step: 108, note: 'C4', duration: 0.3 },
        { step: 112, note: 'G3', duration: 0.5 }, { step: 118, note: 'D4', duration: 0.4 },
        { step: 124, note: 'G4', duration: 0.5 },
      ],
      strings: [
        { step: 32, note: 'G2', duration: 5.0, params: { attack: 0.5, bright: 1500, vol: 0.03 } },
        { step: 64, note: 'G2', duration: 5.0, params: { attack: 0.4, bright: 2000, vol: 0.04 } },
        { step: 96, note: 'F2', duration: 5.0, params: { attack: 0.3, bright: 2200, vol: 0.05 } },
      ],
      sub_bass: [
        { step: 0, note: 'G1', duration: 2.5, params: { vol: 0.08 } },
        { step: 32, note: 'G1', duration: 2.5, params: { vol: 0.10 } },
        { step: 64, note: 'G1', duration: 2.5, params: { vol: 0.12 } },
        { step: 96, note: 'F1', duration: 2.5, params: { vol: 0.12 } },
      ],
      heartbeat: [
        { step: 0, params: { vol: 0.10 } }, { step: 16, params: { vol: 0.10 } },
        { step: 32, params: { vol: 0.10 } }, { step: 48, params: { vol: 0.10 } },
      ],
      noise_hat: [
        { step: 8, params: { vol: 0.025 } }, { step: 24, params: { vol: 0.025 } },
        { step: 40, params: { vol: 0.03 } }, { step: 56, params: { vol: 0.03 } },
        { step: 72, params: { vol: 0.035 } }, { step: 88, params: { vol: 0.035 } },
        { step: 104, params: { vol: 0.035 } }, { step: 120, params: { vol: 0.035 } },
      ],
    }
  },

  // --- CONFESSION: Full emotional weight ---
  {
    name: 'Letters Never Sent - Confession', bpm: 78, steps: 128, repeat: 1,
    tracks: {
      soft_lead: [
        { step: 0, note: 'G4', duration: 1.0, params: { vol: 0.13, vibRate: 5, vibDepth: 5 } },
        { step: 10, note: 'A#4', duration: 0.7, params: { vol: 0.12 } },
        { step: 16, note: 'D5', duration: 1.5, params: { vol: 0.14, vibRate: 6, vibDepth: 6 } },
        { step: 30, note: 'C5', duration: 0.5, params: { vol: 0.12 } },
        { step: 34, note: 'A#4', duration: 0.7, params: { vol: 0.12 } },
        { step: 42, note: 'A4', duration: 1.2, params: { vol: 0.14, vibRate: 5, vibDepth: 6 } },
        { step: 64, note: 'D5', duration: 1.0, params: { vol: 0.14, vibRate: 5, vibDepth: 5 } },
        { step: 74, note: 'F5', duration: 0.7, params: { vol: 0.14 } },
        { step: 80, note: 'G5', duration: 1.8, params: { vol: 0.16, vibRate: 6, vibDepth: 7 } },
        { step: 98, note: 'F5', duration: 0.6, params: { vol: 0.14 } },
        { step: 104, note: 'D5', duration: 0.8, params: { vol: 0.14, vibRate: 5, vibDepth: 5 } },
        { step: 114, note: 'C5', duration: 0.6, params: { vol: 0.13 } },
        { step: 120, note: 'G4', duration: 1.5, params: { vol: 0.14, vibRate: 5, vibDepth: 6 } },
      ],
      choir: [
        { step: 0, note: 'G3', duration: 5.0, params: { vol: 0.045, open: 1400 } },
        { step: 32, note: 'F3', duration: 5.0, params: { vol: 0.05, open: 1500 } },
        { step: 64, note: 'G3', duration: 5.0, params: { vol: 0.055, open: 1700 } },
        { step: 96, note: 'D3', duration: 5.0, params: { vol: 0.05, open: 1300 } },
      ],
      strings: [
        { step: 0, note: 'G2', duration: 5.0, params: { attack: 0.2, bright: 2800, vol: 0.055 } },
        { step: 32, note: 'F2', duration: 5.0, params: { attack: 0.2, bright: 2800, vol: 0.055 } },
        { step: 64, note: 'G2', duration: 5.0, params: { attack: 0.15, bright: 3200, vol: 0.06 } },
        { step: 96, note: 'D2', duration: 5.0, params: { attack: 0.2, bright: 2500, vol: 0.05 } },
      ],
      marimba: [
        { step: 0, note: 'G3', duration: 0.4 }, { step: 4, note: 'D4', duration: 0.3 },
        { step: 8, note: 'A#3', duration: 0.4 }, { step: 12, note: 'D4', duration: 0.3 },
        { step: 16, note: 'G3', duration: 0.4 }, { step: 20, note: 'D4', duration: 0.3 },
        { step: 32, note: 'F3', duration: 0.4 }, { step: 36, note: 'C4', duration: 0.3 },
        { step: 40, note: 'A3', duration: 0.4 }, { step: 44, note: 'C4', duration: 0.3 },
        { step: 48, note: 'F3', duration: 0.4 }, { step: 52, note: 'C4', duration: 0.3 },
        { step: 64, note: 'G3', duration: 0.4 }, { step: 68, note: 'D4', duration: 0.3 },
        { step: 72, note: 'A#3', duration: 0.4 }, { step: 76, note: 'D4', duration: 0.3 },
        { step: 80, note: 'G3', duration: 0.4 }, { step: 84, note: 'D4', duration: 0.3 },
        { step: 96, note: 'D3', duration: 0.4 }, { step: 100, note: 'A3', duration: 0.3 },
        { step: 104, note: 'D3', duration: 0.4 }, { step: 108, note: 'F3', duration: 0.3 },
        { step: 112, note: 'G3', duration: 0.5 },
      ],
      sub_bass: [
        { step: 0, note: 'G1', duration: 2.0, params: { vol: 0.15 } },
        { step: 32, note: 'F1', duration: 2.0, params: { vol: 0.15 } },
        { step: 64, note: 'G1', duration: 2.0, params: { vol: 0.17 } },
        { step: 96, note: 'D1', duration: 2.0, params: { vol: 0.14 } },
      ],
      noise_kick: [
        { step: 0, params: { vol: 0.14 } }, { step: 16 }, { step: 32 }, { step: 48 },
        { step: 64 }, { step: 80 }, { step: 96 }, { step: 112 },
      ],
      noise_snare: [{ step: 16 }, { step: 48 }, { step: 80 }, { step: 112 }],
      noise_hat: every(4, 128, { params: { vol: 0.035 } }),
      delay_lead: [
        { step: 56, note: 'D5', duration: 0.6, params: { echoes: 4, spacing: 0.25, decay: 0.4, vol: 0.05 } },
        { step: 90, note: 'G5', duration: 0.6, params: { echoes: 4, spacing: 0.28, decay: 0.4, vol: 0.05 } },
      ],
      timpani: [{ step: 64, note: 'G2', params: { vol: 0.15 } }],
    }
  },

  // --- LETTING GO: Acceptance. Chord progression resolves toward major ---
  {
    name: 'Letters Never Sent - Letting Go', bpm: 74, steps: 128, repeat: 1,
    tracks: {
      soft_lead: [
        { step: 0, note: 'G4', duration: 1.2, params: { vol: 0.13, vibRate: 4, vibDepth: 4 } },
        { step: 14, note: 'A#4', duration: 0.8, params: { vol: 0.12 } },
        { step: 22, note: 'D5', duration: 1.8, params: { vol: 0.13, vibRate: 5, vibDepth: 5 } },
        { step: 48, note: 'D5', duration: 1.0, params: { vol: 0.12, vibRate: 4, vibDepth: 4 } },
        { step: 58, note: 'C5', duration: 0.7, params: { vol: 0.11 } },
        { step: 66, note: 'A#4', duration: 1.5, params: { vol: 0.11, vibRate: 4, vibDepth: 3 } },
        { step: 84, note: 'G4', duration: 1.0, params: { vol: 0.08, vibRate: 3, vibDepth: 2 } },
        { step: 100, note: 'A#4', duration: 1.5, params: { vol: 0.06, vibRate: 3, vibDepth: 2 } },
      ],
      choir: [
        { step: 0, note: 'G3', duration: 5.0, params: { vol: 0.05, open: 1500 } },
        { step: 32, note: 'A#3', duration: 5.0, params: { vol: 0.045, open: 1300 } },
        { step: 64, note: 'A#3', duration: 6.0, params: { vol: 0.035, open: 1100 } },
      ],
      strings: [
        { step: 0, note: 'G2', duration: 5.0, params: { attack: 0.25, bright: 2500, vol: 0.05 } },
        { step: 32, note: 'A#2', duration: 5.0, params: { attack: 0.3, bright: 2000, vol: 0.04 } },
        { step: 64, note: 'A#2', duration: 6.0, params: { attack: 0.4, bright: 1500, vol: 0.03 } },
      ],
      marimba: [
        { step: 0, note: 'G3', duration: 0.4 }, { step: 8, note: 'D4', duration: 0.3 },
        { step: 16, note: 'A#3', duration: 0.4 }, { step: 24, note: 'D4', duration: 0.3 },
        { step: 32, note: 'A#3', duration: 0.5 }, { step: 44, note: 'F4', duration: 0.4 },
        { step: 56, note: 'A#3', duration: 0.5 },
        { step: 72, note: 'D4', duration: 0.5 },
        { step: 96, note: 'A#4', duration: 0.6 },
      ],
      shimmer: [{ step: 64, note: 'A#2', duration: 8.0, params: { vol: 0.03 } }],
      sub_bass: [
        { step: 0, note: 'G1', duration: 2.0, params: { vol: 0.12 } },
        { step: 32, note: 'A#1', duration: 2.0, params: { vol: 0.10 } },
        { step: 64, note: 'A#1', duration: 3.0, params: { vol: 0.06 } },
      ],
      noise_kick: [
        { step: 0, params: { vol: 0.12 } }, { step: 16, params: { vol: 0.10 } },
        { step: 32, params: { vol: 0.08 } }, { step: 48, params: { vol: 0.06 } },
      ],
      noise_hat: [
        { step: 8, params: { vol: 0.03 } }, { step: 24, params: { vol: 0.025 } },
        { step: 40, params: { vol: 0.02 } },
      ],
      delay_lead: [
        { step: 48, note: 'A#4', duration: 0.8, params: { echoes: 5, spacing: 0.3, decay: 0.4, vol: 0.05 } },
      ],
      fm_bell: [
        { step: 80, note: 'A#5', duration: 3.0, params: { ratio: 2.5, modDepth: 0.3, vol: 0.03 } },
        { step: 112, note: 'D5', duration: 3.0, params: { ratio: 3.0, modDepth: 0.2, vol: 0.02 } },
      ],
      heartbeat: [
        { step: 96, params: { vol: 0.08, gap: 0.25 } },
        { step: 112, params: { vol: 0.06, gap: 0.28 } },
      ],
    }
  },

  // --- SILENCE: Almost nothing. One last bell ---
  {
    name: 'Letters Never Sent - Silence', bpm: 68, steps: 64, repeat: 1,
    tracks: {
      shimmer: [{ step: 0, note: 'G2', duration: 8.0, params: { vol: 0.025 } }],
      fm_bell: [
        { step: 16, note: 'G5', duration: 4.0, params: { ratio: 3.0, modDepth: 0.2, vol: 0.03 } },
        { step: 48, note: 'D5', duration: 4.0, params: { ratio: 2.5, modDepth: 0.15, vol: 0.02 } },
      ],
      heartbeat: [
        { step: 0, params: { vol: 0.05, gap: 0.3 } },
        { step: 24, params: { vol: 0.03, gap: 0.35 } },
      ],
    }
  },
];


// ===================================================================
// ALL COMPOSITIONS
// ===================================================================

const ALL_COMPOSITIONS = {
  'dawn-over-ruins': DAWN_OVER_RUINS,
  'ocean-of-circuits': OCEAN_OF_CIRCUITS,
  'letters-never-sent': LETTERS_NEVER_SENT,
};

if (typeof module !== 'undefined') module.exports = { ALL_COMPOSITIONS, DAWN_OVER_RUINS, OCEAN_OF_CIRCUITS, LETTERS_NEVER_SENT, every };
