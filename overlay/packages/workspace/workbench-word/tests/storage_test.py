"""Native Windows storage checks using disposable synthetic files."""
import sys, os, json, tempfile, unittest, uuid
from pathlib import Path
from unittest.mock import patch
SOURCE, DEPENDENCY, EVIDENCE = map(Path,sys.argv[1:4])
sys.argv=[sys.argv[0]]
sys.path[:0]=[str(SOURCE/"packages/workspace/workbench-word/worker"),str(DEPENDENCY),str(DEPENDENCY/"win32"),str(DEPENDENCY/"win32/lib")]
DLL=os.add_dll_directory(str(DEPENDENCY/"pywin32_system32"))
import safe_save as save
import storage
import win32con, win32security

class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="mrw-071-storage-")
        self.app=Path(self.temp.name)
        self.workspace=EVIDENCE/("workspace-"+uuid.uuid4().hex)
        self.workspace.mkdir(parents=True)
        self.target=self.workspace/"paper.docx";self.target.write_bytes(b"ORIGINAL")
        self.directory=self.app/uuid.uuid4().hex;self.directory.mkdir()
        _,self.baseline=save.read_original(self.workspace,self.target)
    def tearDown(self):self.temp.cleanup()
    def publish(self,data,request):
        result=save.commit(self.workspace,self.target,data,self.baseline,self.directory,request)
        save.finish_commit(result["recovery"],self.directory)
        self.baseline=result["baseline"]
    def checkpoint(self,directory,sequence,scope="A"):
        identifier=str(sequence)+"-"+uuid.uuid4().hex;data=("DRAFT-"+str(sequence)).encode()
        record={"storageVersion":2,"id":directory.name,"scope":scope,"root":str(self.workspace),"path":str(self.target),
            "revision":sequence,"checkpoint":identifier,"checkpointHash":save.sha(data),"checkpointSequence":sequence,"savedRequests":{}}
        save.durable(directory/("checkpoint-"+identifier+".docx"),data)
        save.durable_json(directory/("checkpoint-"+identifier+".json"),record)
        save.durable_json(directory/"record.json",record)
        return {key:record[key] for key in ("id","checkpoint","checkpointHash","revision")}
    def proof(self,sequence):
        data=("PDF-"+str(sequence)).encode()
        record={"revision":sequence,"sha256":save.sha(data),"proofSequence":sequence,"createdAt":1}
        base=self.directory/storage.proof_name(record)
        save.durable(base.with_suffix(".pdf"),data);save.durable_json(base.with_suffix(".json"),record)
        save.durable_json(self.directory/"proof.json",record)
        return {"revision":sequence,"version":record["sha256"]}
    def refs(self,values,proofs=None,scope="A"):
        return {"scope":scope,"root":str(self.workspace),"documents":[{"id":self.directory.name,"checkpoints":values,"proofs":proofs or []}]}
    def gc(self,refs,active=True):
        return storage.retain(self.app,refs,{self.directory.name:1} if active else {})
    def test_three_saves_cross_volume_rotation_and_acl(self):
        def acl():
            value=win32security.GetFileSecurity(str(self.target),win32security.DACL_SECURITY_INFORMATION).GetSecurityDescriptorDacl()
            return [(value.GetAce(i)[0][0],value.GetAce(i)[0][1] & ~0x10,
                *value.GetAce(i)[1:]) for i in range(value.GetAceCount())]
        original=acl()
        for index in range(3):
            data=("SAVED-"+str(index)).encode();self.publish(data,str(index))
            self.assertEqual(self.target.read_bytes(),data)
            self.assertEqual(len(list((self.directory/"backups").glob("*.docx"))),1)
            self.assertEqual(list(self.directory.glob("save-*.json")),[])
            self.assertEqual([p.name for p in self.workspace.iterdir()],["paper.docx"])
        self.assertNotEqual(self.directory.drive,self.target.drive)
        self.assertEqual(acl(),original)
        self.assertEqual(next((self.directory/"backups").glob("*.docx")).read_bytes(),b"SAVED-1")
    def test_unicode_names_across_buffer_alignments_are_exact(self):
        for length in range(16):
            with self.subTest(length=length):
                self.target=self.workspace/("中文😀"+"x"*length+".docx")
                self.target.write_bytes(b"ORIGINAL")
                _,self.baseline=save.read_original(self.workspace,self.target)
                self.publish(b"FIRST","unicode-first-"+str(length))
                self.publish(b"SECOND","unicode-second-"+str(length))
                self.assertEqual(self.target.read_bytes(),b"SECOND")
                pointer=storage.read_json(self.directory/"backup.json")
                self.target.unlink()
                self.assertEqual(save.recover_commit(pointer,self.directory),"restored-original")
                self.assertEqual(self.target.read_bytes(),b"FIRST")
        expected={"paper.docx"}|{"中文😀"+"x"*n+".docx" for n in range(16)}
        self.assertEqual({p.name for p in self.workspace.iterdir()},expected)

    def test_protected_acl_survives_cross_volume_restore(self):
        descriptor=win32security.GetFileSecurity(str(self.target),win32security.OWNER_SECURITY_INFORMATION)
        owner=descriptor.GetSecurityDescriptorOwner()
        acl=win32security.ACL();acl.AddAccessAllowedAce(win32security.ACL_REVISION,win32con.GENERIC_ALL,owner)
        win32security.SetNamedSecurityInfo(str(self.target),win32security.SE_FILE_OBJECT,
            win32security.DACL_SECURITY_INFORMATION|win32security.PROTECTED_DACL_SECURITY_INFORMATION,None,None,acl,None)
        _,self.baseline=save.read_original(self.workspace,self.target)
        self.publish(b"PROTECTED","protected")
        pointer=storage.read_json(self.directory/"backup.json");self.target.unlink()
        self.assertEqual(save.recover_commit(pointer,self.directory),"restored-original")
        restored=win32security.GetFileSecurity(str(self.target),win32security.DACL_SECURITY_INFORMATION)
        self.assertTrue(restored.GetSecurityDescriptorControl()[0]&win32security.SE_DACL_PROTECTED)
        self.assertEqual(restored.GetSecurityDescriptorDacl().GetAceCount(),1)
        self.assertEqual(restored.GetSecurityDescriptorDacl().GetAce(0)[2],owner)
    def test_missing_target_restores_private_backup(self):
        self.publish(b"NEW","saved");pointer=storage.read_json(self.directory/"backup.json");self.target.unlink()
        self.assertEqual(save.recover_commit(pointer,self.directory),"restored-original")
        self.assertEqual(self.target.read_bytes(),b"ORIGINAL")
        self.assertTrue(Path(pointer["backup"]).exists())
    def test_failed_save_preserves_previous_backup(self):
        self.publish(b"FIRST","first");previous=storage.read_json(self.directory/"backup.json")
        real=save.rename_owned
        def fault(handle,destination):
            if Path(destination)==self.target:raise OSError("injected publish and rollback fault")
            return real(handle,destination)
        with patch.object(save,"rename_owned",side_effect=fault):
            with self.assertRaises(save.WordFailure):save.commit(self.workspace,self.target,b"SECOND",self.baseline,self.directory,"second")
        self.assertTrue(Path(previous["backup"]).exists())
        journal=storage.read_json(next(self.directory.glob("save-*.json")))
        self.assertEqual(save.recover_commit(journal,self.directory),"restored-original")
        self.assertEqual(self.target.read_bytes(),b"FIRST")
    def test_mid_save_interruption_recovers_from_other_volume(self):
        real=save.rename_owned
        def fault(handle,destination):
            if Path(destination)==self.target:raise SystemExit("synthetic process loss")
            return real(handle,destination)
        with patch.object(save,"rename_owned",side_effect=fault):
            with self.assertRaises(SystemExit):save.commit(self.workspace,self.target,b"NEW",self.baseline,self.directory,"crash")
        journal=storage.read_json(next(self.directory.glob("save-*.json")))
        self.assertEqual(journal["phase"],"original-retained");Path(journal["displaced"]).unlink()
        self.assertEqual(save.recover_commit(journal,self.directory),"restored-original")
        self.assertEqual(self.target.read_bytes(),b"ORIGINAL")
    def test_external_arrival_is_not_overwritten(self):
        real=save.rename_owned
        def arrival(handle,destination):
            if Path(destination)==self.target and not self.target.exists():self.target.write_bytes(b"EXTERNAL")
            return real(handle,destination)
        with patch.object(save,"rename_owned",side_effect=arrival):
            with self.assertRaises(save.WordFailure):save.commit(self.workspace,self.target,b"NEW",self.baseline,self.directory,"arrival")
        record=storage.read_json(next(self.directory.glob("save-*.json")))
        self.assertEqual(save.recover_commit(record,self.directory),"retained")
        self.assertEqual(self.target.read_bytes(),b"EXTERNAL");self.assertTrue(Path(record["backup"]).exists())
    def test_external_change_and_occupied_target_are_rejected(self):
        self.target.write_bytes(b"EXTERNAL")
        with self.assertRaises(save.WordFailure):save.commit(self.workspace,self.target,b"NEW",self.baseline,self.directory,"changed")
        _,baseline=save.read_original(self.workspace,self.target)
        with save.held(self.target,win32con.GENERIC_READ,0):
            with self.assertRaises(save.WordFailure):save.commit(self.workspace,self.target,b"NEW",baseline,self.directory,"occupied")
        self.assertEqual(self.target.read_bytes(),b"EXTERNAL")
    def test_unacknowledged_commit_keeps_its_journal(self):
        real=save.durable_json
        def fault(path,value):
            if value.get("phase")=="committed":raise OSError("injected acknowledgement fault")
            return real(path,value)
        with patch.object(save,"durable_json",side_effect=fault):
            with self.assertRaises(save.WordFailure):save.commit(self.workspace,self.target,b"NEW",self.baseline,self.directory,"unknown")
        journal=next(self.directory.glob("save-*.json"));record=storage.read_json(journal)
        self.assertEqual(record["phase"],"committed-unacknowledged")
        self.assertEqual(save.recover_commit(record,self.directory),"committed")
        save.clean_terminal_journals(self.directory,{})
        self.assertTrue(journal.exists())
    def test_confirmed_save_journal_is_cleaned_at_startup(self):
        result=save.commit(self.workspace,self.target,b"NEW",self.baseline,self.directory,"confirmed")
        self.checkpoint(self.directory,1);record=storage.read_json(self.directory/"record.json")
        record["savedRequests"]={"confirmed":1};save.durable_json(self.directory/"record.json",record)
        storage.startup(self.app)
        self.assertFalse(Path(result["recovery"]).exists())
    def test_bad_paths_and_changed_backup_refuse_restore(self):
        self.publish(b"NEW","saved");record=storage.read_json(self.directory/"backup.json");self.target.unlink()
        with self.assertRaises(save.WordFailure):save.recover_commit({**record,"backup":str(self.workspace/"unowned")},self.directory)
        Path(record["backup"]).write_bytes(b"TAMPERED")
        with self.assertRaises(save.WordFailure):save.recover_commit(record,self.directory)
        self.assertFalse(self.target.exists())
    def test_latest_scene_and_unacknowledged_checkpoint_pins(self):
        first=self.checkpoint(self.directory,1);second=self.checkpoint(self.directory,2);third=self.checkpoint(self.directory,3)
        self.assertEqual(self.gc(self.refs([first]))["deleted"],0)
        self.assertEqual(self.gc(self.refs([first,third]))["deleted"],1)
        for item in (first,third):self.assertTrue((self.directory/("checkpoint-"+item["checkpoint"]+".docx")).exists())
        self.assertFalse((self.directory/("checkpoint-"+second["checkpoint"]+".docx")).exists())
    def test_proof_latest_scene_and_unacknowledged_pins(self):
        cp=self.checkpoint(self.directory,1);first=self.proof(1);self.proof(2);third=self.proof(3)
        self.assertEqual(self.gc(self.refs([cp],[first]))["deleted"],0)
        self.assertEqual(self.gc(self.refs([cp],[third]))["deleted"],2)
        self.assertTrue((self.directory/(storage.proof_name(third)+".pdf")).exists())
    def test_corrupt_or_unknown_references_disable_deletion(self):
        first=self.checkpoint(self.directory,1);latest=self.checkpoint(self.directory,2)
        self.assertTrue(self.gc(self.refs([{**latest,"checkpointHash":"0"*64}]))["failures"])
        self.assertEqual(len(list(self.directory.glob("checkpoint-*.docx"))),2)
        (self.directory/("checkpoint-"+first["checkpoint"]+".json")).write_text("invalid")
        self.assertTrue(self.gc(self.refs([latest]))["failures"])
        self.assertEqual(len(list(self.directory.glob("checkpoint-*.docx"))),2)
    def test_other_session_is_not_collected(self):
        self.checkpoint(self.directory,1);last=self.checkpoint(self.directory,2)
        other=self.app/uuid.uuid4().hex;other.mkdir();self.checkpoint(other,1,"B");self.checkpoint(other,2,"B")
        self.assertEqual(self.gc(self.refs([last]))["deleted"],1)
        self.assertEqual(len(list(other.glob("checkpoint-*.docx"))),2)
        with self.assertRaises(save.WordFailure):self.gc(self.refs([last],scope="B"))
    def test_closed_vs_unpublished_active_document(self):
        self.checkpoint(self.directory,1);self.checkpoint(self.directory,2)
        empty={"scope":"A","root":str(self.workspace),"documents":[]}
        self.assertEqual(self.gc(empty)["deleted"],0)
        self.assertEqual(self.gc(empty,False)["deleted"],1)
    def test_working_file_cleanup_obeys_native_ownership(self):
        self.checkpoint(self.directory,1);working=self.directory/"working.docx";working.write_bytes(b"WORK")
        with save.held(working,win32con.GENERIC_READ,0):storage.startup(self.app)
        self.assertTrue(working.exists());storage.startup(self.app);self.assertFalse(working.exists())
        self.assertEqual(len(list(self.directory.glob("checkpoint-*.docx"))),1)
    def test_legacy_profile_and_workspace_backup_untouched(self):
        old=self.app/uuid.uuid4().hex;old.mkdir()
        save.durable_json(old/"record.json",{"id":old.name,"scope":"A","root":str(self.workspace)})
        legacy=old/"working-legacy.docx";legacy.write_bytes(b"OLD")
        backup=self.workspace/".paper.docx.mrw-old.backup";backup.write_bytes(b"LEGACY")
        storage.startup(self.app);self.gc({"scope":"A","root":str(self.workspace),"documents":[]},False)
        self.assertEqual(legacy.read_bytes(),b"OLD");self.assertEqual(backup.read_bytes(),b"LEGACY")

EVIDENCE.mkdir(parents=True,exist_ok=True)
result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(StorageTests))
(EVIDENCE/"report.json").write_text(json.dumps({"passed":result.wasSuccessful(),"tests":result.testsRun,
    "failures":[(str(t),e) for t,e in result.failures+result.errors],"syntheticOnly":True,"crossVolume":True},indent=2),encoding="utf8")
raise SystemExit(0 if result.wasSuccessful() else 1)
