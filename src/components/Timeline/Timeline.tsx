import React from 'react'

type EventItem = {
  id: string
  timestamp: string
  text: string
}

const Timeline: React.FC<{ items?: EventItem[] }> = ({ items = [] }) => {
  return (
    <div className="timeline">
      {items.map(item => (
        <div key={item.id} className="timeline-item">
          <div className="time">{item.timestamp}</div>
          <div className="content">{item.text}</div>
        </div>
      ))}
    </div>
  )
}

export default Timeline
