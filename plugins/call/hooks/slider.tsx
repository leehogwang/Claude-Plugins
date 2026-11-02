import type { ClientModule } from 'claude-code'

// A track like "--o---": the knob sits on the current choice; click or drag along it to pick another.
// The choice goes to the hooks module as {set: index}; the track itself is drawn from the props.
export type SliderProps = { levels: number; at: number; len: number; color: string }
type Local = { ref: { p: SliderProps; last: number; off?: () => void } }

const Slider: ClientModule<SliderProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    state = { ref: { p: props, last: props.at } }
    surface.setState(state)
  }
  const ref = state.ref
  ref.p = props
  ref.last = props.at
  ref.off ??= surface.onPointer(e => {
    if (e.type === 'move' ? e.button !== 'left' : e.type !== 'down' || (e.button ?? 'left') !== 'left') return // a drag, or the first click
    const { levels, len } = ref.p
    const x = Math.max(0, Math.min(len - 1, e.x))
    const idx = len <= 1 ? 0 : Math.round((x * (levels - 1)) / (len - 1))
    if (idx !== ref.last) {
      ref.last = idx
      surface.post({ set: idx })
    }
  })
  const knob = props.len <= 1 || props.levels <= 1 ? 0 : Math.round((props.at * (props.len - 1)) / (props.levels - 1))
  return (
    <Box flexDirection="row">
      {Array.from({ length: props.len }, (_, k) =>
        k === knob ? <Text bold color={props.color}>o</Text> : <Text dimColor>-</Text>,
      )}
    </Box>
  )
}

export default Slider
