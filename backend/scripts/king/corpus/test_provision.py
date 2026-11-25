"""Real package install and permission gate; may run in a disposable Linux container."""
import os
from pathlib import Path
import stat
import tempfile
import unittest
import provision
import snapshot as op


class ProvisionTest(unittest.TestCase):
    def test_immutable_portable_install_permissions_and_no_activation(self):
        package=Path(os.environ.get('KING_TEST_PACKAGE',Path(__file__).resolve().parents[4]/'docs/king-of-english/corpus/production-review/packages/king-corpus-2026-10-05-v3'))
        identity='king-corpus-2026-10-05-v3';digest='695c39043dac52dddc95d5b7bd3b0ac012a7498f94067c3230ab112483bf4b4c'
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'king'
            with self.assertRaisesRegex(ValueError,'EXPECTED_FINGERPRINT_MISMATCH'):
                provision.install(root,package,identity,'3','0'*64)
            self.assertFalse(root.exists())
            self.assertEqual(digest,provision.install(root,package,identity,'3',digest))
            state=root/'state';ledger=op.state(state)
            self.assertIsNone(ledger['active']);self.assertIsNone(ledger['snapshots'][identity]['approval'])
            self.assertEqual('../packages/'+identity,ledger['snapshots'][identity]['package'].replace('\\','/'))
            if os.name=='posix':
                for directory in (root,root/'packages',state):self.assertEqual(0o700,stat.S_IMODE(directory.stat().st_mode))
                self.assertEqual(0o600,stat.S_IMODE((state/'state.json').stat().st_mode))
                for name in op.verify(state,identity,ledger)[1]['artifacts']:
                    self.assertEqual(0o400,stat.S_IMODE((root/'packages'/identity/name).stat().st_mode))
            before=(state/'state.json').read_bytes()
            with self.assertRaisesRegex(ValueError,'IMMUTABLE_INSTALL_ALREADY_EXISTS'):
                provision.install(root,package,identity,'3',digest)
            self.assertEqual(before,(state/'state.json').read_bytes())
            moved=Path(temp)/'relocated';root.rename(moved)
            self.assertEqual(digest,op.verify(moved/'state',identity,op.state(moved/'state'))[0]['fingerprint'])


if __name__=='__main__':unittest.main()
