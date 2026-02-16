// Theme management
const THEME_KEY = 'phosphor-theme';

function getSystemTheme() {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

function getSavedTheme() {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem(THEME_KEY);
  }
  return null;
}

function setSavedTheme(theme) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(THEME_KEY, theme);
  }
}

function applyTheme(theme) {
  const html = document.documentElement;
  html.setAttribute('data-theme', theme);
  setSavedTheme(theme);
}

function initializeTheme() {
  const savedTheme = getSavedTheme();
  const theme = savedTheme || getSystemTheme();
  applyTheme(theme);
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
  updateThemeToggleButton(newTheme);
}

function updateThemeToggleButton(theme) {
  const button = document.querySelector('.theme-toggle');
  if (button) {
    button.innerHTML = theme === 'light' ? '<span class="material-symbols-outlined">dark_mode</span>' : '<span class="material-symbols-outlined">light_mode</span>';
  }
}

function init() {
  initializeTheme();
  updateThemeToggleButton(document.documentElement.getAttribute('data-theme'));

  const themeToggle = document.querySelector('.theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', toggleTheme);
  }

  // Listen for system theme changes
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!getSavedTheme()) {
        applyTheme(e.matches ? 'dark' : 'light');
        updateThemeToggleButton(e.matches ? 'dark' : 'light');
      }
    });
  }

  // Initialize sidebar folders
  initSidebarFolders();
}

// Sidebar folder toggle functionality
function initSidebarFolders() {
  const FOLDER_EXPANDED_KEY = 'phosphor-sidebar-folders';

  function getSavedFolderStates() {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(FOLDER_EXPANDED_KEY);
      return saved ? JSON.parse(saved) : {};
    }
    return {};
  }

  function saveFolderState(folder, isExpanded) {
    if (typeof localStorage !== 'undefined') {
      const states = getSavedFolderStates();
      states[folder] = isExpanded;
      localStorage.setItem(FOLDER_EXPANDED_KEY, JSON.stringify(states));
    }
  }

  function toggleFolder(button) {
    const group = button.closest('.sidebar-folder-group');
    const folderNav = group.querySelector('.sidebar-folder-nav');
    const folder = group.getAttribute('data-folder');

    const isExpanded = button.getAttribute('aria-expanded') === 'true';
    const newState = !isExpanded;

    button.setAttribute('aria-expanded', newState);

    if (newState) {
      folderNav.style.display = 'block';
      folderNav.classList.add('expanded');
    } else {
      folderNav.classList.remove('expanded');
      setTimeout(() => {
        if (button.getAttribute('aria-expanded') !== 'true') {
          folderNav.style.display = 'none';
        }
      }, 200);
    }

    saveFolderState(folder, newState);
  }

  // Initialize folder toggles
  const buttons = document.querySelectorAll('.sidebar-folder-toggle');
  const savedStates = getSavedFolderStates();

  buttons.forEach(button => {
    const group = button.closest('.sidebar-folder-group');
    const folder = group.getAttribute('data-folder');
    const folderNav = group.querySelector('.sidebar-folder-nav');

    // Restore saved state (default to collapsed)
    const isExpanded = savedStates[folder] || false;

    button.setAttribute('aria-expanded', isExpanded);

    if (isExpanded) {
      folderNav.style.display = 'block';
      folderNav.classList.add('expanded');
    }

    button.addEventListener('click', () => toggleFolder(button));
  });

  // Expand folder if it contains the active page
  const activeLink = document.querySelector('.sidebar-nav-link.active');
  if (activeLink) {
    const folderNav = activeLink.closest('.sidebar-folder-nav');
    if (folderNav) {
      const button = folderNav.previousElementSibling;
      if (button && button.classList.contains('sidebar-folder-toggle')) {
        button.setAttribute('aria-expanded', 'true');
        folderNav.style.display = 'block';
        folderNav.classList.add('expanded');
        saveFolderState(folderNav.closest('.sidebar-folder-group').getAttribute('data-folder'), true);
      }
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
