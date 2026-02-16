<script setup lang="ts">
import type { Ref } from 'vue'
import { ref } from 'vue'
import { useStore } from '../../store'
import { Tabs as TabsEnum } from '../../types'
import PageTitle from '../PageTitle.vue'
import Credits from './Credits.vue'
import Imports from './Imports/index.vue'
import Info from './Info.vue'
import Options from './Options/index.vue'
import SearchBox from './SearchBox/index.vue'
import Tabs from './Tabs.vue'

const tabs: TabsEnum[] = [
  TabsEnum.AddItems,
  TabsEnum.Options,
  TabsEnum.ImportsExports,
  TabsEnum.Info,
]

const store = useStore()

const currentTab: Ref<TabsEnum> = ref(TabsEnum.AddItems)

function setCurrentTab(tab: TabsEnum) {
  currentTab.value = tab
  if (store.$state.collapsed) {
    store.toggleCollapse()
  }
}
</script>

<template>
  <div :class="`sidebar-container ${store.$state.collapsed ? 'collapsed' : ''}`">
    <Tabs
      :tabs="tabs"
      :current-tab="currentTab"
      class="mobile-tabs"
      @set-current-tab="setCurrentTab"
    />
    <div class="sidebar">
      <div class="sidebar-block title-block">
        <PageTitle />
      </div>
      <div class="tabbed-sidebar-block">
        <Tabs
          :tabs="tabs"
          :current-tab="currentTab"
          class="desktop-tabs"
          @set-current-tab="setCurrentTab"
        />
        <div class="sidebar-content">
          <SearchBox :class="currentTab === TabsEnum.AddItems ? '' : 'hidden-tab'" />
          <Options :class="currentTab === TabsEnum.Options ? '' : 'hidden-tab'" />
          <Imports :class="currentTab === TabsEnum.ImportsExports ? '' : 'hidden-tab'" />
          <Info :class="currentTab === TabsEnum.Info ? '' : 'hidden-tab'" />
          <div
            v-if="currentTab === TabsEnum.AddItems || currentTab === TabsEnum.Info"
            class="sidebar-block mobile-credits-block"
          >
            <Credits />
          </div>
        </div>
      </div>
      <div class="sidebar-block desktop-credits-block">
        <Credits />
      </div>
    </div>
  </div>
</template>

<style scoped>
.sidebar-container {
  height: 100%;
}

.sidebar {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.hidden-tab {
  display: none;
}

.mobile-credits-block {
  display: none;
}

.mobile-tabs {
  display: none;
}

.sidebar-block {
  margin: 10px;
  width: calc(100% - 20px);
  background: rgba(20, 20, 20, 0.8);
  border-radius: 6px;
  text-align: center;
  padding: 10px;
}

.tabbed-sidebar-block {
  margin: 10px;
  width: calc(100% - 20px);
  text-align: center;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.sidebar-content {
  text-align: left;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
  background: rgba(20, 20, 20, 0.8);
  border-radius: 0 6px 6px 6px;
  padding: 16px;
}

@media screen and (max-width: 1000px) {
  .title-block {
    display: none;
  }

  .sidebar {
    height: 100%;
    background: #000000;
    width: 100%;
  }

  .sidebar-block {
    width: 100%;
    margin: 0;
    border-radius: 0;
    padding: 10px 0;
    max-height: 100%;
  }

  .sidebar-content {
    max-height: 100%;
    border-radius: 0;
    background: #000000;
  }

  .announcement {
    display: none;
  }

  .tabbed-sidebar-block {
    margin: 10px;
    width: calc(100% - 20px);
    min-height: 0;
  }

  .desktop-credits-block {
    display: none;
  }

  .mobile-credits-block {
    display: initial;
  }

  .mobile-tabs {
    display: flex;
  }

  .desktop-tabs {
    display: none;
  }

  .sidebar-container.collapsed {
    height: 100%;
    overflow: visible;
    background: transparent;
  }

  .sidebar-container.collapsed .sidebar {
    height: 100%;
    filter: none;
  }

  .sidebar-container.collapsed .sidebar .tabbed-sidebar-block {
    background: transparent;
    height: auto;
    max-height: none;
  }
}
</style>
