import React, { useEffect, useState } from 'react'
import Timeline from '../components/Timeline/Timeline'
import TopNav from '../components/TopNav'

const mockSessions = [
  { id: 's1', title: 'Morning Work', updated: '2026-10-14T08:23:00Z' }
]

const Dashboard: React.FC = () => {
  const [sessions] = useState(mockSessions)
  const [events, setEvents] = useState([])

  useEffect(() => {
    // Example: call preload API (will return [])
    ;(window as any).rewind?.getSessions().then((s: any) => {
      // no-op for now
    })

    setEvents([
      { id: 'e1', timestamp: '08:00', text: 'Opened file report.docx' },
      { id: 'e2', timestamp: '08:05', text: 'Edited report.docx' }
    ])
  }, [])

  return (
    <div>
      <TopNav />
      <main className="container">
        <section className="sessions">
          <h2>Recent sessions</h2>
          <ul>
            {sessions.map(s => (
              <li key={s.id}>{s.title} — {new Date(s.updated).toLocaleString()}</li>
            ))}
          </ul>
        </section>

        <section className="timeline-section">
          <h2>Timeline (sample)</h2>
          <Timeline items={events} />
        </section>
      </main>
    </div>
  )
}

export default Dashboard
