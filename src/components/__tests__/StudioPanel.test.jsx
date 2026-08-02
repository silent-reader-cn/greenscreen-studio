// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
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
      projects: [
        { id: 'qa_project', name: '[UI QA] Dense drawer', characterName: 'Long QA Character', description: 'Primary project summary', updatedAt: '2026-08-01T09:30:00.000Z' },
        { id: 'qa_project_2', name: 'Second project', characterName: 'Second Character', updatedAt: '2026-08-01T08:00:00.000Z' },
      ],
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
      assets: Array.from({ length: 10 }, (_, index) => ({
        id: `asset_${index + 1}`,
        role: 'source',
        kind: 'image',
        originalName: `asset-${index + 1}.png`,
        path: `/fixtures/asset-${index + 1}.png`,
      })),
    }))
  }
  if (url === '/api/projects/qa_project_2') {
    return Promise.resolve(response({
      project: { id: 'qa_project_2', name: 'Second project', characterName: 'Second Character' },
      assets: [],
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

  it('exposes project and MCP tabs without collaboration controls', async () => {
    const { container } = render(<StudioPanel />)

    fireEvent.click(screen.getByRole('button', { name: t('studio.panelShort') }))
    const tabList = await screen.findByRole('tablist', { name: t('studio.panelTitle') })
    const tabs = screen.getAllByRole('tab')

    expect(tabList.className).toContain('studio-tabs')
    expect(tabs).toHaveLength(2)
    expect(tabs.every(tab => tab.tagName === 'BUTTON')).toBe(true)
    expect(screen.getByRole('tab', { name: t('studio.tabProjects') }).getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('.studio-project-create')).toBeTruthy()
    expect(container.querySelector('.studio-body-projects')).toBeTruthy()
    expect(screen.getByRole('button', { name: t('studio.refresh') }).querySelector('svg')).toBeTruthy()
    expect(screen.getByRole('button', { name: t('studio.close') }).querySelector('svg')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: t('studio.tabMcp') }))
    expect(container.querySelector('.studio-body-mcp')).toBeTruthy()
    expect(container.querySelectorAll('.studio-body-mcp .studio-meta-item')).toHaveLength(4)
    expect(container.querySelector('.studio-code-wrap .studio-copy-config-btn')).toBeTruthy()
    expect(container.querySelector('.studio-body-collab')).toBeNull()
    expect(container.querySelector('.studio-message-create')).toBeNull()
  })

  it('expands project rows in place and lists every recent asset', async () => {
    const { container } = render(<StudioPanel />)

    fireEvent.click(screen.getByRole('button', { name: t('studio.panelShort') }))
    const projectName = await screen.findByText('[UI QA] Dense drawer')
    const projectButton = projectName.closest('button')

    expect(projectButton.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(projectButton)

    expect(projectButton.getAttribute('aria-expanded')).toBe('true')
    await screen.findAllByText('asset-10.png')
    const expandedDetail = container.querySelector('.studio-project-expanded')
    expect(expandedDetail.querySelector('code[title="/fixtures/asset-10.png"]')).toBeTruthy()
    expect(expandedDetail.querySelectorAll('.studio-row')).toHaveLength(10)

    fireEvent.click(projectButton)
    expect(projectButton.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.studio-project-expanded')).toBeNull()
  })
})
