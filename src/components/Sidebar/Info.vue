<script setup lang="ts">
import { BIconBoxArrowUpRight } from 'bootstrap-icons-vue'
</script>

<template>
  <div>
    <div>
      <a class="changelog-link" href="/changelog.txt" target="_blank" rel="noopener noreferrer">Changelog <BIconBoxArrowUpRight /></a>
    </div>
    <div id="faq">
      <h2>Frequently Asked Questions</h2>
      <h3>Why can't I find any King Crimson albums?</h3>
      <p>Not everything in the databases has cover art attached. Because charts require cover art, thoughtslibrary filters out items that are missing it. For example, occasionally a band decides they don't want their cover art to appear in databases anymore, so they file a copyright takedown. You may have seen this happen on other sites such as Rate Your Music. This is very rare but it can affect popular items--as of this writing, all of King Crimson's releases are missing album art on Last.fm and as a result will not appear in search results.</p>
      <h3>Why is it called thoughtslibrary?</h3>
      <p>This is your personal fork of the original project, renamed for your own use and future customizations.</p>
    </div>
  </div>
</template>

<style scoped>
h2 {
  margin: 0;
}

#faq {
  font-size: 0.9rem;
}

.changelog-link {
  color: inherit;
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
  margin-bottom: 10px;
}
</style>
