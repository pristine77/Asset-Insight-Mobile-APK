import fs from 'node:fs';
import path from 'node:path';

const repository = fs.readFileSync(path.resolve(__dirname,
  '../../modules/auction-camera/android/src/main/java/expo/modules/auctioncamera/viewextensions/LotRepository.kt'), 'utf8');

describe('downstream asynchronous native journal integration', () => {
  it('captures fixed-lot authority with the queued immutable session', () => {
    expect(repository).toContain('val structure: FixedLotStructure?');
    expect(repository).toContain('JournalSnapshot(activeLotNumberForSession, completedLots.toList(), active, fixedStructure)');
    expect(repository).toContain('buildSessionJson(snapshot.activeLotNumber, snapshot.lots, snapshot.active, snapshot.structure)');
    const serializer = repository.slice(repository.indexOf('private fun buildSessionJson(activeLotNumber: Int, lots:'), repository.indexOf('fun restoreSessionFromCache'));
    expect(serializer).toContain('structure?.saveTo(root)');
    expect(serializer).not.toMatch(/fixedStructure|activeBuilder|toJson\(completedLots\)/);
  });

  it('keeps ordered off-main writes and a bounded Done flush', () => {
    expect(repository).toContain('Executors.newSingleThreadExecutor()');
    expect(repository).toContain('ioExecutor.execute {');
    expect(repository).toContain('write.get(JOURNAL_FLUSH_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)');
    expect(repository).toContain('pendingJournalWrites.get() == 0');
  });
});
