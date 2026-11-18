import { useState } from 'react'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { routes } from '../routes/routes'
import { Providers } from './Providers'
import { createQueryClient } from './queryClient'

export function App() {
  const [client] = useState(createQueryClient)
  const [router] = useState(() => createBrowserRouter(routes))
  return (
    <Providers client={client}>
      <RouterProvider router={router} />
    </Providers>
  )
}
