using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Windows.Storage;

namespace SaveBridge
{
    /// <summary>
    /// Reads the WGS (Windows Gaming Save) filesystem layout that Xbox Live
    /// Connected Storage creates under:
    ///   %LOCALAPPDATA%\Packages\{PackageFamilyName}\SystemAppData\wgs\
    ///
    /// Structure (reverse-engineered by Xbox Live Save Exporter project):
    ///   wgs\
    ///     {XUID_hex}\              — one folder per signed-in user
    ///       containers.index       — binary: header + folder list
    ///       {FOLDER_GUID}\         — one folder per container
    ///         container.{N}        — binary: header + file list
    ///         {BLOB_GUID}          — raw save blob
    /// </summary>
    public static class WgsReader
    {
        /// <summary>
        /// Enumerate the WGS tree rooted at <paramref name="wgsPath"/> and
        /// return a JSON string listing every user / container / blob.
        /// </summary>
        public static async Task<string> EnumerateAsync(string wgsPath)
        {
            var sb = new StringBuilder();
            sb.Append("{\"wgsPath\":\"").Append(Escape(wgsPath)).Append("\",\"users\":[");

            bool firstUser = true;
            if (!Directory.Exists(wgsPath))
            {
                sb.Append("]}");
                return sb.ToString();
            }

            foreach (var userDir in Directory.GetDirectories(wgsPath))
            {
                string containerIndexPath = Path.Combine(userDir, "containers.index");
                if (!File.Exists(containerIndexPath)) continue;

                if (!firstUser) sb.Append(",");
                firstUser = false;

                string userId = Path.GetFileName(userDir);
                sb.Append("{\"userId\":\"").Append(Escape(userId)).Append("\",\"containers\":[");

                ContainerIndex index = null;
                try { index = ParseContainerIndex(containerIndexPath); } catch { }

                if (index != null)
                {
                    bool firstContainer = true;
                    foreach (var folder in index.Folders)
                    {
                        if (!firstContainer) sb.Append(",");
                        firstContainer = false;

                        sb.Append("{\"name\":\"").Append(Escape(folder.Name)).Append("\"")
                          .Append(",\"id\":").Append(folder.ContainerId)
                          .Append(",\"guid\":\"").Append(folder.Guid.ToString("N").ToUpperInvariant()).Append("\"")
                          .Append(",\"path\":\"").Append(Escape(folder.Path)).Append("\"")
                          .Append(",\"blobs\":[");

                        // Parse container.N inside the GUID folder
                        string containerFilePath = Path.Combine(folder.Path, "container." + folder.ContainerId);
                        List<BlobEntry> blobs = null;
                        try { blobs = ParseContainerFile(containerFilePath, folder.Path); } catch { }

                        if (blobs != null)
                        {
                            bool firstBlob = true;
                            foreach (var blob in blobs)
                            {
                                if (!firstBlob) sb.Append(",");
                                firstBlob = false;
                                long size = -1;
                                try { size = new FileInfo(blob.Path).Length; } catch { }
                                sb.Append("{\"name\":\"").Append(Escape(blob.Name)).Append("\"")
                                  .Append(",\"guid\":\"").Append(blob.Guid.ToString("N").ToUpperInvariant()).Append("\"")
                                  .Append(",\"size\":").Append(size)
                                  .Append(",\"relativePath\":\"").Append(Escape(MakeRelative(wgsPath, blob.Path))).Append("\"")
                                  .Append("}");
                            }
                        }
                        sb.Append("]}");
                    }
                }
                sb.Append("]}");
            }

            sb.Append("]}");
            return sb.ToString();
        }

        // ------------------------------------------------------------------ //
        //  Binary parsing — containers.index
        // ------------------------------------------------------------------ //

        private static ContainerIndex ParseContainerIndex(string path)
        {
            using (var stream = File.OpenRead(path))
            using (var reader = new BinaryReader(stream))
            {
                int type       = reader.ReadInt32();
                int numFolders = reader.ReadInt32();

                string friendlyName     = ReadUnicodeString(reader, reader.ReadInt32());
                string fullName         = ReadUnicodeString(reader, reader.ReadInt32());
                string[] nameParts      = fullName.Split('!');
                string packageFullName  = nameParts[0];
                string id               = nameParts.Length > 1 ? nameParts[1] : "";

                // Skip unknown 12 bytes
                reader.ReadBytes(0xc);

                // Unknown GUID
                Guid containerGuid = new Guid(ReadUnicodeString(reader, reader.ReadInt32()));

                if (type == 0xe)
                    reader.ReadBytes(8);  // extra padding in newer format

                var folders = new List<ContainerFolder>();
                string baseDir = Path.GetDirectoryName(path);

                for (int i = 0; i < numFolders; i++)
                {
                    string folderName    = ReadUnicodeString(reader, reader.ReadInt32());
                    string secondName    = ReadUnicodeString(reader, reader.ReadInt32());
                    string unknownValue  = ReadUnicodeString(reader, reader.ReadInt32());
                    byte   containerId   = reader.ReadByte();

                    reader.ReadBytes(4); // unknown

                    Guid folderGuid = ReadGuid(reader);

                    reader.ReadBytes(0x18); // unknown tail

                    string folderPath = Path.Combine(baseDir, folderGuid.ToString("N").ToUpperInvariant());
                    folders.Add(new ContainerFolder(folderName, containerId, folderGuid, folderPath));
                }

                return new ContainerIndex(friendlyName, packageFullName, id, containerGuid, folders);
            }
        }

        // ------------------------------------------------------------------ //
        //  Binary parsing — container.N
        // ------------------------------------------------------------------ //

        private static List<BlobEntry> ParseContainerFile(string path, string baseDir)
        {
            if (!File.Exists(path)) return new List<BlobEntry>();

            using (var stream = File.OpenRead(path))
            using (var reader = new BinaryReader(stream))
            {
                int type     = reader.ReadInt32();
                int numFiles = reader.ReadInt32();
                var files    = new List<BlobEntry>();

                for (int i = 0; i < numFiles; i++)
                {
                    string fileName = ReadFixedUnicodeString(reader, 0x40).TrimEnd('\0');
                    Guid   guid     = ReadGuid(reader);
                    Guid   guid2    = ReadGuid(reader);  // second GUID (same data, ignored)

                    string filePath = Path.Combine(baseDir, guid.ToString("N").ToUpperInvariant());
                    files.Add(new BlobEntry(fileName, guid, filePath));
                }
                return files;
            }
        }

        // ------------------------------------------------------------------ //
        //  Binary reading helpers
        // ------------------------------------------------------------------ //

        /// <summary>Read a UTF-16LE string of <paramref name="charCount"/> characters.</summary>
        private static string ReadUnicodeString(BinaryReader reader, int charCount)
        {
            var bytes = reader.ReadBytes(charCount * 2);
            return Encoding.Unicode.GetString(bytes).TrimEnd('\0');
        }

        /// <summary>Read a fixed 128-byte (64-wchar) UTF-16LE field.</summary>
        private static string ReadFixedUnicodeString(BinaryReader reader, int byteCount)
        {
            var bytes = reader.ReadBytes(byteCount * 2);
            return Encoding.Unicode.GetString(bytes).TrimEnd('\0');
        }

        /// <summary>Read a big-endian–per-component GUID (as stored in WGS index files).</summary>
        private static Guid ReadGuid(BinaryReader reader)
        {
            byte[] g1 = reader.ReadBytes(4); Array.Reverse(g1);
            byte[] g2 = reader.ReadBytes(2); Array.Reverse(g2);
            byte[] g3 = reader.ReadBytes(2); Array.Reverse(g3);
            byte[] g4 = reader.ReadBytes(2);
            byte[] g5 = reader.ReadBytes(6);
            return new Guid(
                BitConverter.ToString(g1).Replace("-", "") + "-" +
                BitConverter.ToString(g2).Replace("-", "") + "-" +
                BitConverter.ToString(g3).Replace("-", "") + "-" +
                BitConverter.ToString(g4).Replace("-", "") + "-" +
                BitConverter.ToString(g5).Replace("-", ""));
        }

        private static string MakeRelative(string root, string full)
        {
            if (full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                return full.Substring(root.Length).TrimStart('\\', '/');
            return full;
        }

        private static string Escape(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "\\n");
        }

        // ------------------------------------------------------------------ //
        //  Internal data models
        // ------------------------------------------------------------------ //

        private sealed class ContainerIndex
        {
            public string FriendlyName     { get; }
            public string PackageFullName  { get; }
            public string Id               { get; }
            public Guid   Guid             { get; }
            public List<ContainerFolder> Folders { get; }
            public ContainerIndex(string fn, string pfn, string id, Guid g, List<ContainerFolder> f)
            { FriendlyName = fn; PackageFullName = pfn; Id = id; Guid = g; Folders = f; }
        }

        private sealed class ContainerFolder
        {
            public string Name        { get; }
            public byte   ContainerId { get; }
            public Guid   Guid        { get; }
            public string Path        { get; }
            public ContainerFolder(string n, byte id, Guid g, string p)
            { Name = n; ContainerId = id; Guid = g; Path = p; }
        }

        private sealed class BlobEntry
        {
            public string Name { get; }
            public Guid   Guid { get; }
            public string Path { get; }
            public BlobEntry(string n, Guid g, string p) { Name = n; Guid = g; Path = p; }
        }
    }
}
