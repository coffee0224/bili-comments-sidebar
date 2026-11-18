// Toggle sidebar when toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => {
  if (tab.url && tab.url.includes('bilibili.com/video/')) {
    chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' });
  }
});
