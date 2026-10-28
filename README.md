# Transit Identifier

Figures out which BART or Caltrain train you're on from your phone's location and live data, then shows when you'll reach each stop.

**Open it:** https://davidspies.github.io/transit-identifier/

## How it works
- **BART:** your GPS position is matched to the stretch of track between two stations; direction comes from your movement. The train is the one BART's live departure estimates say reaches the next station soonest on that line. Later stops are chained from each station's estimates (marked `~` when estimated from run time instead).
- **Caltrain:** needs a free [511.org key](https://511.org/open-data/token) (Settings). Matches you to the nearest live train position heading your way, then reads its predicted stop times. 511 allows 60 requests/hour, so the app polls every ~2 min.
- Tap **Yes, this is my train** to lock on; tap **Not my train** to release.

## Testing without riding
Add `?sim=lat,lon,heading` to the URL, e.g. `?sim=37.8045,-122.2950,240` (West Oakland → SF direction).
