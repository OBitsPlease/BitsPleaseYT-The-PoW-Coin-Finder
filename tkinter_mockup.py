from tkinter import *
from tkinter import ttk
import webbrowser

root = Tk()
root.title("BitsPleaseYT The PoW Coin Finder. - Mockup")
root.geometry("500x350")

coins = [
    {"name": "CoinA", "website": "https://coina.org", "github": "https://github.com/coina", "explorer": "https://explorer.coina.org"},
    {"name": "CoinB", "website": "https://coinb.com", "github": "https://github.com/coinb", "explorer": "https://explorer.coinb.com"},
    {"name": "CoinC", "website": "https://coinc.net", "github": "https://github.com/coinc", "explorer": "https://explorer.coinc.net"},
]

def open_url(url):
    webbrowser.open(url)

frame = ttk.Frame(root, padding=10)
frame.pack(fill=BOTH, expand=True)

for coin in coins:
    row = Frame(frame)
    row.pack(fill=X, pady=5)
    Label(row, text=coin["name"], width=10, anchor=W, font=("Arial", 12, "bold")).pack(side=LEFT)
    Button(row, text="Website", command=lambda url=coin["website"]: open_url(url)).pack(side=LEFT, padx=2)
    Button(row, text="GitHub", command=lambda url=coin["github"]: open_url(url)).pack(side=LEFT, padx=2)
    Button(row, text="Explorer", command=lambda url=coin["explorer"]: open_url(url)).pack(side=LEFT, padx=2)

Label(root, text="Python/Tkinter GUI Mockup", font=("Arial", 10, "italic")).pack(side=BOTTOM, pady=5)

root.mainloop()
