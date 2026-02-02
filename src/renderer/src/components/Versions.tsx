import { useState } from 'react';

type ElectronVersions = {
  electron: string;
  chrome: string;
  node: string;
  [key: string]: string;
};

function Versions(): React.JSX.Element {
  const initialVersions: ElectronVersions = { electron: '', chrome: '', node: '' };
  const win = window as unknown as Window & {
    electron?: { process?: { versions?: ElectronVersions } };
  };
  const [versions] = useState<ElectronVersions>(win.electron?.process?.versions ?? initialVersions);

  return (
    <ul className="versions">
      <li className="electron-version">Electron v{versions.electron}</li>
      <li className="chrome-version">Chromium v{versions.chrome}</li>
      <li className="node-version">Node v{versions.node}</li>
    </ul>
  );
}

export default Versions;
