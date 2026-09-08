jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Share: { share: jest.fn() },
}));

jest.mock('@react-native-documents/picker', () => ({
  saveDocuments: jest.fn(),
}));

import { saveDocuments } from '@react-native-documents/picker';
import { Platform, Share } from 'react-native';
import { saveLocalFile } from '../src/fileSave';

const mockPlatform = Platform as { OS: string };
const mockShare = Share.share as jest.Mock;
const mockSaveDocuments = saveDocuments as jest.Mock;

describe('saveLocalFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlatform.OS = 'android';
  });

  test('uses the Android save dialog with an encoded file URI', async () => {
    mockSaveDocuments.mockResolvedValue([
      { uri: 'content://saved/report.pdf', name: 'report.pdf', error: null },
    ]);

    await expect(
      saveLocalFile('/data/user/0/com.dshmobile/cache/report #1?.pdf', 'report.pdf', 'application/pdf'),
    ).resolves.toBe('saved');

    expect(mockSaveDocuments).toHaveBeenCalledWith({
      sourceUris: ['file:///data/user/0/com.dshmobile/cache/report%20%231%3F.pdf'],
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
    });
    expect(mockShare).not.toHaveBeenCalled();
  });

  test('rejects when the Android save result contains an error', async () => {
    mockSaveDocuments.mockResolvedValue([
      { uri: '', name: null, error: 'cannot write document' },
    ]);

    await expect(saveLocalFile('/cache/file.bin', 'file.bin')).rejects.toThrow(
      'cannot write document',
    );
  });

  test('keeps the native share sheet on iOS', async () => {
    mockPlatform.OS = 'ios';
    mockShare.mockResolvedValue({ action: 'sharedAction' });

    await expect(saveLocalFile('/cache/my file.png', 'my file.png', 'image/png')).resolves.toBe(
      'shared',
    );

    expect(mockShare).toHaveBeenCalledWith({
      url: 'file:///cache/my%20file.png',
      title: 'my file.png',
    });
    expect(mockSaveDocuments).not.toHaveBeenCalled();
  });
});
