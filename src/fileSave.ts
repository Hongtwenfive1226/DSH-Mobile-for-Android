import { saveDocuments } from '@react-native-documents/picker';
import { Platform, Share } from 'react-native';

export type SaveFileOutcome = 'saved' | 'shared';

function toFileUri(localPath: string): string {
  const absolutePath = localPath.startsWith('/') ? localPath : `/${localPath}`;
  const encodedPath = absolutePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `file://${encodedPath}`;
}

export async function saveLocalFile(
  localPath: string,
  fileName: string,
  mimeType = 'application/octet-stream',
): Promise<SaveFileOutcome> {
  const uri = toFileUri(localPath);

  if (Platform.OS === 'android') {
    const [result] = await saveDocuments({ sourceUris: [uri], fileName, mimeType });
    if (result.error) throw new Error(result.error);
    return 'saved';
  }

  await Share.share({ url: uri, title: fileName });
  return 'shared';
}
