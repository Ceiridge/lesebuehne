/** Auto-follow of the text pane (B8): follows the current sentence until the user scrolls. */
export type FollowState = 'follow' | 'paused';

export type FollowEvent = 'user-scroll' | 'play' | 'back-to-current' | 'navigate';

export function autoFollow(state: FollowState, event: FollowEvent): FollowState {
  switch (event) {
    case 'user-scroll':
      return 'paused';
    case 'play':
    case 'back-to-current':
    case 'navigate':
      return 'follow';
  }
}
