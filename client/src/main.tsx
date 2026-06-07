import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexProvider, ConvexReactClient } from 'convex/react'
import App from './App'
import './index.css'

// We always render a ConvexProvider so the leaderboard hooks (useQuery /
// useMutation) can be called unconditionally. When VITE_CONVEX_URL isn't
// configured we point the client at a localhost stub and gate every query
// with 'skip' (see isConvexConfigured), so a missing-URL build runs as a
// fully offline, local-leaderboard-only game without console noise.
//
// We trim the env var because some hosts preserve whitespace pasted into the
// value field; a leading space would make the URL fail to parse and the client
// would silently never connect.
const rawConvexUrl = (import.meta.env.VITE_CONVEX_URL as string | undefined)?.trim()
const convexUrl = rawConvexUrl && rawConvexUrl.length > 0 ? rawConvexUrl : 'http://127.0.0.1:3210'
const convex = new ConvexReactClient(convexUrl)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
)
