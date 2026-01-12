import React, { useReducer, useEffect, useRef } from 'react';
import { extractFrontmatter } from '../utils/frontmatterUtils';

interface FrontmatterModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentFile: string | null;
  content: string;
  onSave: (updatedContent: string) => void;
  onDelete?: (filename: string) => void;
}

interface FormState {
  editedFields: Record<string, string>;
  newFieldName: string;
  newFieldValue: string;
}

type FormAction =
  | { type: 'INIT_FORM'; fields: Record<string, string> }
  | { type: 'CHANGE_FIELD'; key: string; value: string }
  | { type: 'CHANGE_NEW_FIELD_NAME'; value: string }
  | { type: 'CHANGE_NEW_FIELD_VALUE'; value: string }
  | { type: 'ADD_FIELD'; name: string; value: string }
  | { type: 'DELETE_FIELD'; key: string }
  | { type: 'RESET' };

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'INIT_FORM':
      return {
        editedFields: action.fields,
        newFieldName: '',
        newFieldValue: ''
      };
    case 'CHANGE_FIELD':
      return {
        ...state,
        editedFields: { ...state.editedFields, [action.key]: action.value }
      };
    case 'CHANGE_NEW_FIELD_NAME':
      return { ...state, newFieldName: action.value };
    case 'CHANGE_NEW_FIELD_VALUE':
      return { ...state, newFieldValue: action.value };
    case 'ADD_FIELD':
      return {
        editedFields: { ...state.editedFields, [action.name]: action.value },
        newFieldName: '',
        newFieldValue: ''
      };
    case 'DELETE_FIELD': {
      const updated = { ...state.editedFields };
      delete updated[action.key];
      return { ...state, editedFields: updated };
    }
    case 'RESET':
      return { editedFields: {}, newFieldName: '', newFieldValue: '' };
    default:
      return state;
  }
}

export function FrontmatterModal({
  isOpen,
  onClose,
  currentFile,
  content,
  onSave,
  onDelete
}: FrontmatterModalProps): React.JSX.Element {
  const [formState, dispatch] = useReducer(formReducer, {
    editedFields: {},
    newFieldName: '',
    newFieldValue: ''
  });
  const prevIsOpenRef = useRef(isOpen);

  useEffect(() => {
    // Only initialize when modal opens (isOpen transitions from false to true)
    if (isOpen && !prevIsOpenRef.current) {
      const { frontmatter: fm } = extractFrontmatter(content);
      if (fm) {
        const fields: Record<string, string> = {};
        Object.entries(fm.content).forEach(([key, value]) => {
          fields[key] = typeof value === 'string' ? value : JSON.stringify(value);
        });
        dispatch({ type: 'INIT_FORM', fields });
      } else {
        dispatch({ type: 'RESET' });
      }
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, content]);

  const handleFieldChange = (key: string, value: string): void => {
    dispatch({ type: 'CHANGE_FIELD', key, value });
  };

  const handleAddField = (): void => {
    if (formState.newFieldName.trim()) {
      dispatch({ type: 'ADD_FIELD', name: formState.newFieldName, value: formState.newFieldValue });
    }
  };

  const handleDeleteField = (key: string): void => {
    dispatch({ type: 'DELETE_FIELD', key });
  };

  const handleSave = (): void => {
    // Reconstruct frontmatter with edited fields
    const lines = ['---'];
    Object.entries(formState.editedFields).forEach(([key, value]) => {
      lines.push(`${key}: ${value}`);
    });
    lines.push('---');

    const { content: contentOnly } = extractFrontmatter(content);
    const newContent = lines.join('\n') + '\n' + contentOnly;

    onSave(newContent);
    onClose();
  };

  const handleDelete = (): void => {
    if (currentFile && window.confirm(`Delete ${currentFile}?`)) {
      onDelete?.(currentFile);
      onClose();
    }
  };

  if (!isOpen) return <></>;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>File Settings</h2>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        {Object.keys(formState.editedFields).length === 0 ? (
          <div className="modal-body">
            <p>No frontmatter found. Add fields to create frontmatter.</p>
          </div>
        ) : (
          <div className="modal-body">
            <div className="frontmatter-fields">
              <h3>Metadata Fields</h3>
              {Object.entries(formState.editedFields).map(([key, value]) => (
                <div key={key} className="field-row">
                  <div className="field-label">{key}</div>
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => handleFieldChange(key, e.target.value)}
                    className="field-input"
                  />
                  <button
                    className="field-delete-btn"
                    onClick={() => handleDeleteField(key)}
                    title="Delete field"
                  >
                    🗑️
                  </button>
                </div>
              ))}

              <div className="add-field">
                <h3>Add Field</h3>
                <div className="field-row">
                  <input
                    type="text"
                    placeholder="Field name"
                    value={formState.newFieldName}
                    onChange={(e) =>
                      dispatch({ type: 'CHANGE_NEW_FIELD_NAME', value: e.target.value })
                    }
                    className="field-input"
                  />
                  <input
                    type="text"
                    placeholder="Value"
                    value={formState.newFieldValue}
                    onChange={(e) =>
                      dispatch({ type: 'CHANGE_NEW_FIELD_VALUE', value: e.target.value })
                    }
                    className="field-input"
                  />
                  <button className="field-add-btn" onClick={handleAddField}>
                    +
                  </button>
                </div>
              </div>
            </div>

            <div className="file-actions">
              <h3>File</h3>
              <div className="file-info">
                <strong>Name:</strong> {currentFile}
              </div>
              <button className="delete-file-btn" onClick={handleDelete}>
                🗑️ Delete File
              </button>
            </div>
          </div>
        )}

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export default FrontmatterModal;
