// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StudioPanel from '../StudioPanel.jsx'
import { t } from '../../i18n.js'

class EventSourceMock {
  addEventListener() {}
  close() {}
}

function response(data) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(data),
  }
}

function mockApi(url) {
  if (url === '/api/projects') {
    return Promise.resolve(response({
      projects: [{ id: 'qa_project', name: '[UI QA] Dense drawer', characterName: 'Long QA Character' }],
    }))
  }
  if (url === '/api/projects/qa_project') {
    return Promise.resolve(response({
      project: {
        id: 'qa_project',
        name: '[UI QA] Dense drawer',
        characterName: 'Long QA Character',
        description: 'Long fixture description for responsive layout checks.',
      },
      assets: [],
      tasks: [{
        id: 'task_1',
        title: 'Long running visual QA task',
        description: 'A deliberately long task description.',
        status: 'open',
        assignee: 'ai',
        priority: 'high',
      }],
      messages: [{ id: 'message_1', author: 'UI QA', body: 'Long fixture message.' }],
    }))
  }
  if (url === '/api/mcp/status') return Promise.resolve(response({ connected: true }))
  if (url === '/api/mcp/config') return Promise.resolve(response({ formats: { json: '{\"mcpServers\":{}}' } }))
  if (url === '/api/mcp/logs?limit=80') return Promise.resolve(response({ logs: [] }))
  return Promise.resolve(response({}))
}

describe('StudioPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(mockApi))
    vi.stubGlobal('EventSource', EventSourceMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('exposes equal semantic tabs and distinct form row layouts', async () => {
    const { container } = render(<StudioPanel />)

    fireEvent.click(screen.getByRole('button', { name: t('studio.panelShort') }))
    const tabList = await screen.findByRole('tablist', { name: t('studio.panelTitle') })
    const tabs = screen.getAllByRole('tab')

    expect(tabList.className).toContain('studio-tabs')
    expect(tabs).toHaveLength(3)
    expect(tabs.every(tab => tab.tagName === 'BUTTON')).toBe(true)
    expect(screen.getByRole('tab', { name: t('studio.tabProjects') }).getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('.studio-project-create')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: t('studio.tabCollab') }))
    expect(screen.getByRole('tab', { name: t('studio.tabCollab') }).getAttribute('aria-selected')).toBe('true')

    await waitFor(() => expect(container.querySelector('.studio-message-create')).toBeTruthy())
    expect(screen.getByPlaceholderText(t('studio.taskDescription')).tagName).toBe('TEXTAREA')
  })
})
