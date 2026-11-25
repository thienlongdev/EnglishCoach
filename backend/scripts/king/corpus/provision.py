"""Install a new verified immutable package in operator-owned storage; never approve/activate."""
import argparse
import os
from pathlib import Path
import shutil
import tempfile

import snapshot as op


def install(root, package, snapshot_id, version, fingerprint):
    root=Path(root).absolute();package=Path(package).resolve()
    definition,_=op.validate_package(package,snapshot_id,version,'king-snapshot-3')
    if op.sha(op.encode(definition))!=fingerprint:
        raise ValueError('EXPECTED_FINGERPRINT_MISMATCH')
    # Check operator paths before changing permissions or installing anything.
    for path in (root,*root.parents):
        if path.is_symlink():raise ValueError('OPERATOR_PATH_SYMLINK')
    old_umask=os.umask(0o077)
    try:
        root.mkdir(parents=True,exist_ok=True,mode=0o700)
        packages=root/'packages';state=root/'state'
        for path in (packages,state):
            if path.is_symlink():raise ValueError('OPERATOR_PATH_SYMLINK')
            path.mkdir(exist_ok=True,mode=0o700)
        for path in (root,packages,state):
            if os.name=='posix' and path.stat().st_uid!=os.geteuid():raise ValueError('OPERATOR_DIRECTORY_NOT_OWNED')
            path.chmod(0o700)
        dest=packages/snapshot_id
        if dest.exists() or dest.is_symlink() or snapshot_id in op.state(state)['snapshots']:
            raise ValueError('IMMUTABLE_INSTALL_ALREADY_EXISTS')
        with tempfile.TemporaryDirectory(prefix='.install-',dir=packages) as temp:
            staged=Path(temp)/snapshot_id;staged.mkdir(mode=0o700)
            for name,digest in definition['artifacts'].items():
                source=package/name;target=staged/name
                if source.is_symlink() or not target.resolve().is_relative_to(staged.resolve()):raise ValueError('INVALID_ARTIFACT_PATH')
                target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
                shutil.copyfile(source,target)
                if op.sha(target.read_bytes())!=digest:raise ValueError('COPY_HASH_MISMATCH')
                target.chmod(0o400)
            copied,_=op.validate_package(staged,snapshot_id,version,'king-snapshot-3')
            if op.encode(copied)!=op.encode(definition):raise ValueError('INSTALL_REVALIDATION_MISMATCH')
            # Serialize package publication and ledger creation with the existing operator lock.
            with op.locked(state):
                if dest.exists():raise ValueError('IMMUTABLE_INSTALL_ALREADY_EXISTS')
                staged.rename(dest)
            # No approval or active pointer is written by create.
            result=op.create(state,dest,snapshot_id,version,'king-snapshot-3',True)
            if result!=fingerprint:raise ValueError('INSTALLED_FINGERPRINT_MISMATCH')
        return result
    finally:os.umask(old_umask)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('root','package','id','version','fingerprint'):p.add_argument('--'+name,required=True)
    args=p.parse_args()
    print(install(args.root,args.package,args.id,args.version,args.fingerprint))


if __name__=='__main__':main()
