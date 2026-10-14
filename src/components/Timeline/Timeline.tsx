import React from 'react'

export type EventItem = {
  id: string
  timestamp: string
  text: string
}

// placeholder Timeline component
const Timeline: React.FC<{ items?: EventItem[] }> = () => null

export default Timeline
