// A small bridge from the timeline to the map camera (the map is created imperatively
// and lazily, so the timeline cannot hold a reference to it).

export const camera = {
  /**
   * Called when playback starts. The map frames the whole trip if this is the first
   * play of this plan or if the truck or the route is off screen, and returns how many
   * milliseconds to wait before playing so the truck does not start mid-animation.
   */
  beforePlay: (): number => 0,
}
