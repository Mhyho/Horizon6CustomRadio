"""下载真实音乐评测数据（不会进入仓库）：Salsa 数据集（Zenodo 13120822，CC BY 4.0）。

124 段 30 秒、48kHz 的真实 salsa 录音片段 + 专家标注的拍点（毫秒）。只有节拍 / 速度真值，
没有强拍、段落标注，所以只能用来验证速度和节拍跟踪。
数据集论文：Salsa, a Dataset for Beat Estimation in Salsa Music (TISMIR, doi:10.5334/tismir.183)。

用法：python3 tests/fetch_real_data.py <输出目录>
然后：node tests/eval.js real <输出目录>
"""
import os
import sys
import urllib.request
import zipfile

BASE = 'https://zenodo.org/api/records/13120822/files/'
FILES = ['beat_annotations.zip', 'audio_fragments.zip']


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'salsa'
    os.makedirs(out, exist_ok=True)
    for name in FILES:
        dst = os.path.join(out, name)
        if not os.path.exists(dst):
            print('下载', name)
            urllib.request.urlretrieve(BASE + name + '/content', dst)
    zipfile.ZipFile(os.path.join(out, 'beat_annotations.zip')).extractall(os.path.join(out, 'ann'))
    zipfile.ZipFile(os.path.join(out, 'audio_fragments.zip')).extractall(os.path.join(out, 'aud'))
    print('完成：', out)


if __name__ == '__main__':
    main()
