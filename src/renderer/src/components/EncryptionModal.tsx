import React, { useState } from 'react';
import '../styles/EncryptionModal.css';

interface EncryptionModalProps {
  isOpen: boolean;
  mode: 'unlock' | 'create';
  onSubmit: (password: string) => void;
  onCancel: () => void;
  isLoading?: boolean;
  error?: string;
}

export function EncryptionModal({
  isOpen,
  mode,
  onSubmit,
  onCancel,
  isLoading = false,
  error
}: EncryptionModalProps): React.ReactElement | null {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();

    if (mode === 'unlock') {
      onSubmit(password);
    } else {
      // Create mode: validate passwords match
      if (password !== confirmPassword) {
        alert('Passwords do not match');
        return;
      }
      if (password.length < 8) {
        alert('Password must be at least 8 characters');
        return;
      }
      onSubmit(password);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent): void => {
    // Only close if clicking the backdrop itself, not the modal
    if (e.target === e.currentTarget) {
      onCancel();
    }
  };

  const isUnlock = mode === 'unlock';
  const isCreate = mode === 'create';
  const buttonDisabled =
    isLoading || !password || (isCreate && !confirmPassword) || (isCreate && password.length < 8);

  return (
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div className="modal-content encryption-modal" onClick={(e) => e.stopPropagation()}>
        <div className="encryption-modal-header">
          <h2>{isUnlock ? 'Unlock Vault' : 'Create Password'}</h2>
          <button className="encryption-modal-close" onClick={onCancel} type="button">
            ✕
          </button>
        </div>

        <div className="encryption-modal-body">
          <p className="encryption-modal-description">
            {isUnlock
              ? 'Enter your vault password to continue'
              : 'Set a password to encrypt your vault'}
          </p>

          <form onSubmit={handleSubmit} className="encryption-form">
            {/* Password Input */}
            <div className="form-group">
              <label htmlFor="password">Password</label>
              <div className="password-input-wrapper">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isUnlock ? 'Enter password' : 'Create password'}
                  disabled={isLoading}
                  autoFocus
                  className="password-input"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  disabled={isLoading}
                  className="show-password-btn"
                >
                  {showPassword ? '🙈' : '👁️'}
                </button>
              </div>
            </div>

            {/* Confirm Password (only for create mode) */}
            {isCreate && (
              <div className="form-group">
                <label htmlFor="confirm-password">Confirm Password</label>
                <input
                  id="confirm-password"
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm password"
                  disabled={isLoading}
                  className="password-input"
                />
              </div>
            )}

            {/* Password Strength Indicator (create mode) */}
            {isCreate && password && (
              <div className="password-strength">
                <div className="strength-bar">
                  <div
                    className={`strength-fill ${getStrengthLevel(password)}`}
                    style={{
                      width: `${getStrengthPercentage(password)}%`
                    }}
                  />
                </div>
                <span className="strength-label">{getStrengthLabel(password)}</span>
              </div>
            )}

            {/* Error Message */}
            {error && <div className="encryption-error">{error}</div>}

            {/* Buttons */}
            <div className="encryption-buttons">
              <button
                type="button"
                onClick={onCancel}
                disabled={isLoading}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button type="submit" disabled={buttonDisabled} className="btn-primary">
                {isLoading ? '⏳ ' : ''}
                {isUnlock ? 'Unlock' : 'Create Password'}
              </button>
            </div>

            {/* Info Text */}
            {isCreate && (
              <p className="encryption-info">
                Use a strong password. You cannot recover it if forgotten.
              </p>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

/**
 * Calculate password strength (0-100)
 */
function getStrengthPercentage(password: string): number {
  let strength = 0;

  // Length
  if (password.length >= 8) strength += 20;
  if (password.length >= 12) strength += 15;
  if (password.length >= 16) strength += 15;

  // Character variety
  if (/[a-z]/.test(password)) strength += 10;
  if (/[A-Z]/.test(password)) strength += 10;
  if (/[0-9]/.test(password)) strength += 10;
  if (/[^a-zA-Z0-9]/.test(password)) strength += 10;

  return Math.min(strength, 100);
}

function getStrengthLevel(password: string): string {
  const strength = getStrengthPercentage(password);
  if (strength < 30) return 'weak';
  if (strength < 60) return 'fair';
  return 'strong';
}

function getStrengthLabel(password: string): string {
  const strength = getStrengthPercentage(password);
  if (strength < 30) return 'Weak';
  if (strength < 60) return 'Fair';
  return 'Strong';
}
