// Register lifecycle feedback only. No tab/navigation listeners, buffers, or native connections.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.action.setTitle({ title: 'Rewind: collection unavailable in this starter' });
});
