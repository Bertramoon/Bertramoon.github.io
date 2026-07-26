import { defineClientConfig } from 'vuepress/client'

export default defineClientConfig({
  setup() {
    if (typeof window === 'undefined') return

    // 监听 medium-zoom 克隆的图片，移除其 zoom 样式
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (
            node.nodeType === 1 &&
            node.classList?.contains('medium-zoom-image--opened')
          ) {
            node.style.removeProperty('zoom')
          }
        }
      }
    })

    observer.observe(document.body, { childList: true, subtree: true })
  },
})
