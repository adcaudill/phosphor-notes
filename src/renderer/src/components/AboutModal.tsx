import React, { useState, useEffect } from 'react';
import '../styles/AboutModal.css';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Versions {
  electron?: string;
  chrome?: string;
  node?: string;
  app?: string;
}

export function AboutModal({ isOpen, onClose }: AboutModalProps): React.ReactElement | null {
  const [versions, setVersions] = useState<Versions>({});

  useEffect(() => {
    if (!isOpen) return;

    // Fetch versions from the main process
    const loadVersions = async (): Promise<void> => {
      try {
        const v = await window.phosphor.getVersions?.();
        if (v) {
          setVersions(v);
        }
      } catch (error) {
        console.error('Failed to get versions:', error);
      }
    };

    loadVersions();
  }, [isOpen]);

  if (!isOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const appVersion = versions.app || '1.0.0';
  const appName = 'Phosphor Notes';
  const appUrl = 'https://github.com/adcaudill/phosphor-notes';

  return (
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div className="modal-content about-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="about-header">
          <button className="about-close" onClick={onClose} type="button" aria-label="Close">
            ✕
          </button>
        </div>

        {/* Main Content */}
        <div className="about-content">
          {/* Logo/Icon Area */}
          <div className="about-icon-area">
            <div className="about-app-icon">
              <svg
                viewBox="0 0 64 64"
                width="64"
                height="64"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                {/* Stylized phosphor/light icon */}
                <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="2" />
                <circle cx="32" cy="32" r="20" fill="currentColor" opacity="0.1" />
                <circle cx="32" cy="32" r="14" stroke="currentColor" strokeWidth="2" />
                {/* Glow lines */}
                <line
                  x1="32"
                  y1="10"
                  x2="32"
                  y2="4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <line
                  x1="54"
                  y1="32"
                  x2="60"
                  y2="32"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <line
                  x1="32"
                  y1="54"
                  x2="32"
                  y2="60"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <line
                  x1="10"
                  y1="32"
                  x2="4"
                  y2="32"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          </div>

          {/* App Name and Description */}
          <h1 className="about-title">{appName}</h1>
          <p className="about-version">Version {appVersion}</p>
          <p className="about-description">
            A minimal, secure, and focused knowledge studio for the modern thinker.
          </p>

          {/* Links */}
          <div className="about-links">
            <a href={appUrl} className="about-link" target="_blank" rel="noopener noreferrer">
              GitHub Repository
              <span className="about-link-icon">↗</span>
            </a>
          </div>

          {/* Divider */}
          <div className="about-divider"></div>

          {/* Technical Details */}
          <div className="about-section">
            <h3 className="about-section-title">Technical Details</h3>
            <div className="about-versions">
              {versions.electron && (
                <div className="version-item">
                  <span className="version-label">Electron</span>
                  <span className="version-value">v{versions.electron}</span>
                </div>
              )}
              {versions.chrome && (
                <div className="version-item">
                  <span className="version-label">Chromium</span>
                  <span className="version-value">v{versions.chrome}</span>
                </div>
              )}
              {versions.node && (
                <div className="version-item">
                  <span className="version-label">Node.js</span>
                  <span className="version-value">v{versions.node}</span>
                </div>
              )}
            </div>
          </div>

          {/* Copyright Footer */}
          <div className="about-footer">
            <p className="about-copyright">© 2026 Adam Caudill. See License for details.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
