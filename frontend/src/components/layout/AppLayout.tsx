import { Allotment } from 'allotment'
import 'allotment/dist/style.css'

import { useUIStore } from '../../stores/uiStore'
import { ActivityBar } from './ActivityBar'
import { Sidebar } from './Sidebar'
import { MainPanel } from './MainPanel'
import { BottomPanel } from './BottomPanel'
import { StatusBar } from './StatusBar'

export function AppLayout() {
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const bottomPanelVisible = useUIStore((s) => s.bottomPanelVisible);

  return (
    <div className="h-screen flex flex-col">
      <div className="flex-1 flex overflow-hidden">
        <ActivityBar />
        <Allotment>
          {sidebarVisible && (
            <Allotment.Pane preferredSize={280} minSize={200} maxSize={500}>
              <Sidebar />
            </Allotment.Pane>
          )}
          <Allotment.Pane>
            <Allotment vertical>
              <Allotment.Pane>
                <MainPanel />
              </Allotment.Pane>
              {bottomPanelVisible && (
                <Allotment.Pane preferredSize={200} minSize={100} snap>
                  <BottomPanel />
                </Allotment.Pane>
              )}
            </Allotment>
          </Allotment.Pane>
        </Allotment>
      </div>
      <StatusBar />
    </div>
  );
}
