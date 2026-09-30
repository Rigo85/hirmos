-- Permission to start audible media is not a defective track. Old diagnostics
-- remain intact, but an active legacy autoplay block becomes a waiting state.
ALTER TABLE playback_sessions DROP CONSTRAINT playback_sessions_render_phase_check;
ALTER TABLE playback_sessions ADD CONSTRAINT playback_sessions_render_phase_check
  CHECK (render_phase IN ('unknown','loading','buffering','playing','paused','awaiting_interaction','error','blocked'));

UPDATE playback_sessions
SET render_phase='awaiting_interaction', status='paused',
    failure_state=failure_state - 'since' - 'consecutive' - 'omitted' - 'healthySince',
    revision=revision+1
WHERE render_phase='blocked' AND failure_state->'notices'->-1->>'code'='autoplay';
